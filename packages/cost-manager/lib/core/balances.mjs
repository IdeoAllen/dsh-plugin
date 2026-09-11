#!/usr/bin/env node
/**
 * balances —— 各平台余额与状态一键体检
 *
 * 为什么要它：余额散落在不同平台（DeepSeek / Kimi / 火山引擎 / Evolink / 智谱 …），
 * 每次要登录好几个后台。这个脚本把能自动查的全部查回来，查不到的明确标注，
 * 避免"以为还有钱，结果跑到一半 429/欠费"。
 *
 * 用法：
 *   node balances.mjs           # 人读表格
 *   node balances.mjs --json    # 机器可读
 *
 * 说明：
 *   - 只读检查，不产生任何费用（不调用任何生成接口；智谱的探测走免费模型）。
 *   - 火山引擎用 AK/SK 走 SigV4 签名查 billing 接口。
 *   - 查不到余额的平台如实标注"需人工查"，绝不猜数字。
 *   - 没配凭据的平台标"缺凭据"，不写死结论。
 *
 * 性能约定（面板首屏用）：
 *   - 单家探测超时 3s（COST_CHECK_TIMEOUT_MS 可调）。原来 6 家共用 20s 超时，
 *     任何一家网络抖动都会把整块面板拖到 20 秒 —— 现在由短板决定，不被最慢的一家绑住。
 *   - checkAll() 默认带 45s 结果缓存（ttlMs 可调）；手动刷新传 { force: true } 强制重测。
 *   - 慢探测（智谱：一次 chat completion，实测约 5s）非 force 时复用上次结果，
 *     避免每次打开设置页都付这 5 秒。
 *
 * 兼容性：凭据路径跟随 DSH_HOME（默认回落到 ~/.toa3/harness-runtime/.dsh），
 *   读不到凭据时返回"缺凭据"而不是在 import 阶段抛异常。
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { pathToFileURL } from 'node:url'

const JSON_OUT = process.argv.includes('--json')

/**
 * 单家探测超时（毫秒）。可用 COST_CHECK_TIMEOUT_MS 覆盖。
 * 取 6s 是实测标定的：国内网络下正常余额接口实测 1.6–4.7s（Kimi 1.7 / 火山 3.9 / MXAPI 4.7），
 * 3s 会把正常平台误判成超时，太紧；原来统一 20s 又会让一家抖动拖住整块面板。
 */
const TIMEOUT_MS = Number(process.env.COST_CHECK_TIMEOUT_MS || 6000)
/** checkAll 结果默认缓存时长（毫秒）。面板自动加载走缓存，手动刷新 force 重测。 */
const DEFAULT_TTL_MS = Number(process.env.COST_BALANCE_TTL_MS || 45000)

/** 凭据文件位置：跟随 DSH_HOME；DSH_HOME 缺失时回落到历史默认路径。 */
function credentialsPath() {
  const home = process.env.DSH_HOME || path.join(process.env.USERPROFILE || '', '.toa3', 'harness-runtime', '.dsh')
  return path.join(home, '.credentials.yaml')
}

let credGetter = null
/** 懒加载 + 容错：读不到凭据文件时所有 key 都是 undefined（表现为"缺凭据"），不抛异常。 */
function get(key) {
  if (!credGetter) {
    let text = ''
    try {
      text = fs.readFileSync(credentialsPath(), 'utf8')
    } catch {
      text = '' // 换机器/换 DSH_HOME 时不应该让整个模块炸掉
    }
    // 注意：凭据 YAML 的键带缩进，必须允许前导空白
    credGetter = (k) => (text.match(new RegExp(`^\\s*${k}:\\s*(\\S+)`, 'm')) || [])[1]
  }
  return credGetter(key)
}

/**
 * 统一的只读请求。默认 3s 超时；超时不抛，返回 http:'TIMEOUT' 交给调用方如实标注。
 */
async function fetchJson(url, options = {}) {
  const { timeoutMs = TIMEOUT_MS, ...init } = options
  try {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
    const text = await r.text()
    try {
      return { http: r.status, body: JSON.parse(text) }
    } catch {
      return { http: r.status, body: text.slice(0, 200) }
    }
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError'
    return { http: timedOut ? 'TIMEOUT' : 'ERR', body: timedOut ? `${timeoutMs}ms 内未返回` : error.message }
  }
}

/** 非成功路径的统一状态文案（如实标注，不猜数字）。 */
function failStatus(platform, http, body) {
  if (http === 'TIMEOUT') {
    return { platform, status: '⏱ 查询超时', balance: null, note: `单家超时 ${TIMEOUT_MS}ms，需人工查或手动刷新重试` }
  }
  return { platform, status: `⚠️ HTTP ${http}`, balance: null, note: String(body).slice(0, 80) }
}

/** DeepSeek 余额 */
async function deepseek() {
  const key = get('DEEPSEEK_API_KEY')
  if (!key) return { platform: 'DeepSeek', status: '缺凭据', balance: null }
  const { http, body } = await fetchJson('https://api.deepseek.com/user/balance', { headers: { Authorization: `Bearer ${key}` } })
  const cny = body?.balance_infos?.find((b) => b.currency === 'CNY')
  if (!body?.is_available) return failStatus('DeepSeek', http, body)
  return {
    platform: 'DeepSeek',
    status: '✅ 可用',
    balance: cny ? `¥${Number(cny.total_balance).toFixed(2)}` : null,
    note: cny ? `充值余额 ¥${Number(cny.topped_up_balance).toFixed(2)}` : '',
  }
}

/** Kimi / Moonshot 余额 */
async function moonshot() {
  const key = get('MOONSHOT_API_KEY')
  if (!key) return { platform: 'Kimi (Moonshot)', status: '缺凭据', balance: null }
  const { http, body } = await fetchJson('https://api.moonshot.cn/v1/users/me/balance', { headers: { Authorization: `Bearer ${key}` } })
  const b = body?.data
  if (!b) return failStatus('Kimi (Moonshot)', http, body)
  return {
    platform: 'Kimi (Moonshot)',
    status: '✅ 可用',
    balance: `¥${Number(b.available_balance).toFixed(2)}`,
    note: `现金 ¥${Number(b.cash_balance).toFixed(2)} / 代金券 ¥${Number(b.voucher_balance).toFixed(2)}`,
  }
}

/** Evolink：额度（credits） */
async function evolink() {
  const key = get('EVOLINK_API_KEY')
  if (!key) return { platform: 'Evolink', status: '缺凭据', balance: null }
  const { http, body } = await fetchJson('https://api.evolink.ai/v1/credits', { headers: { Authorization: `Bearer ${key}` } })
  const u = body?.data?.user
  const t = body?.data?.token
  if (!u) return failStatus('Evolink', http, body)
  const cnyPerCredit = 0.099 // 实测：0.26 credits = ¥0.026
  return {
    platform: 'Evolink',
    status: '✅ 可用',
    balance: `${Number(u.remaining_credits).toFixed(2)} credits ≈ ¥${(u.remaining_credits * cnyPerCredit).toFixed(2)}`,
    note: `已用 ${Number(u.used_credits).toFixed(2)}｜token 标记 unlimited=${t?.unlimited_credits === true}`,
  }
}

/** 火山引擎：账户余额（SigV4 签名） */
async function volcengine() {
  const ak = get('VOLC_ACCESS_KEY_ID')
  const sk = get('VOLC_SECRET_ACCESS_KEY')
  if (!ak || !sk) return { platform: '火山引擎(方舟)', status: '缺凭据', balance: null }
  const host = 'billing.volcengineapi.com'
  const query = 'Action=QueryBalanceAcct&Version=2022-01-01'
  const region = 'cn-north-1'
  const service = 'billing'
  const bodyHash = crypto.createHash('sha256').update('').digest('hex')
  const xDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '')
  const shortDate = xDate.slice(0, 8)
  const signedHeaders = 'host;x-content-sha256;x-date'
  const canonical = ['GET', '/', query, `host:${host}\nx-content-sha256:${bodyHash}\nx-date:${xDate}\n`, signedHeaders, bodyHash].join('\n')
  const scope = `${shortDate}/${region}/${service}/request`
  const stringToSign = ['HMAC-SHA256', xDate, scope, crypto.createHash('sha256').update(canonical).digest('hex')].join('\n')
  const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest()
  const signing = hmac(hmac(hmac(hmac(sk, shortDate), region), service), 'request')
  const signature = crypto.createHmac('sha256', signing).update(stringToSign).digest('hex')
  const { http, body } = await fetchJson(`https://${host}/?${query}`, {
    headers: {
      Authorization: `HMAC-SHA256 Credential=${ak}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      'X-Date': xDate,
      'X-Content-Sha256': bodyHash,
    },
  })
  const r = body?.Result
  if (!r) return failStatus('火山引擎(方舟)', http, body)
  return {
    platform: '火山引擎(方舟)',
    status: '✅ 可用',
    balance: `¥${Number(r.AvailableBalance).toFixed(2)}`,
    note: `现金 ¥${Number(r.CashBalance).toFixed(2)}｜欠费 ¥${Number(r.ArrearsBalance).toFixed(2)}`,
  }
}

/**
 * 智谱：无公开余额接口，只能靠一次免费模型探测判断账户是否欠费。
 * 这是唯一一个"慢探测"（一次完整 chat completion，实测约 5s），
 * 非 force 时复用上次结果，不让面板每次打开都付这 5 秒。
 */
async function zhipu({ force = false } = {}) {
  const key = get('ZAI_CODING_CN_API_KEY')
  if (!key) return { platform: '智谱(ZAI)', status: '缺凭据', balance: null }
  const prev = slowCache.get('智谱(ZAI)')
  if (!force && prev) {
    return { ...prev, stale: true, note: `${prev.note}（上次探测结果；点"刷新"可重测）` }
  }
  const started = Date.now()
  const { http, body } = await fetchJson('https://open.bigmodel.cn/api/paas/v4/chat/completions', {
    method: 'POST',
    timeoutMs: Math.max(TIMEOUT_MS, 8000), // 探测型检查单独放宽，仍远小于原来的 20s
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'glm-4v-flash', messages: [{ role: 'user', content: 'hi' }] }),
  })
  const freeOk = Array.isArray(body?.choices)
  const result = {
    platform: '智谱(ZAI)',
    status: freeOk ? '⚠️ 免费模型可用 / 付费额度不足' : http === 'TIMEOUT' ? '⏱ 探测超时' : '❓ 状态未知',
    balance: null,
    note: `无公开余额接口，用免费 glm-4v-flash 探测（${Date.now() - started}ms）`,
  }
  if (freeOk) slowCache.set('智谱(ZAI)', result)
  return result
}

/** MXAPI：积分余额（1 元 = 100 积分） */
async function mxapi() {
  const key = get('MXAPI_API_KEY')
  if (!key) return { platform: 'MXAPI', status: '缺凭据', balance: null }
  const { http, body } = await fetchJson('https://open.mxapi.org/api/v2/points/balance', {
    headers: { Authorization: `Bearer ${key}` },
  })
  const points = body?.data?.remaining_points
  if (typeof points !== 'number') return failStatus('MXAPI', http, body)
  return {
    platform: 'MXAPI',
    status: '✅ 可用',
    balance: `${points} 积分 = ¥${(points / 100).toFixed(2)}`,
    note: '接口走 v2（/api/v2/…）；单价见 /api/v2/points/logs 明细',
  }
}

/**
 * LabNana：原来这里是一条**写死的常量**（永远 ❌ 不可用 / 未知），
 * 导致别人没配这家也照样显示、恢复了你也不知道。
 * 现在改为凭据驱动 + 实测探测：
 *   - 没配 LABNANA_API_KEY → "未接入"，不占用注意力；
 *   - 配了 → 轻量只读探测（默认 /v1/models，可用 LABNANA_BALANCE_PATH 换成余额接口）；
 *   - 该平台无公开余额接口时如实说明"余额需人工查"，不猜数字。
 * 可用 LABNANA_PROBE=off 关闭探测（只按凭据显示）。
 */
async function labnana() {
  const key = get('LABNANA_API_KEY')
  if (!key) return { platform: 'LabNana', status: '未接入', balance: null, note: '未配置 LABNANA_API_KEY' }
  if (String(process.env.LABNANA_PROBE || '').toLowerCase() === 'off') {
    return { platform: 'LabNana', status: '已接入 · 待探测', balance: null, note: '探测已关闭（LABNANA_PROBE=off）' }
  }
  const base = (get('LABNANA_BASE_URL') || 'https://api.labnana.com').replace(/\/+$/, '')
  const probePath = process.env.LABNANA_BALANCE_PATH || '/v1/models'
  const { http, body } = await fetchJson(`${base}${probePath}`, { headers: { Authorization: `Bearer ${key}` } })
  if (http === 200) {
    const amount = body?.data?.balance ?? body?.balance
    return {
      platform: 'LabNana',
      status: '✅ 可达',
      balance: typeof amount === 'number' ? `¥${Number(amount).toFixed(2)}` : null,
      note: typeof amount === 'number' ? '' : `${probePath} 可达；该平台无私开余额字段，余额需人工查`,
    }
  }
  if (http === 401 || http === 403) return { platform: 'LabNana', status: '⚠️ 凭据无效', balance: null, note: `HTTP ${http}` }
  if (http === 'TIMEOUT') return { platform: 'LabNana', status: '⏱ 探测超时', balance: null, note: `单家超时 ${TIMEOUT_MS}ms` }
  if (http === 404) return { platform: 'LabNana', status: '❓ 探测端点不存在', balance: null, note: `HTTP 404：${probePath}；可用 LABNANA_BALANCE_PATH 指定真实端点` }
  return { platform: 'LabNana', status: `⚠️ HTTP ${http}`, balance: null, note: String(body).slice(0, 80) }
}

const CHECKS = [deepseek, moonshot, evolink, volcengine, mxapi, zhipu, labnana]

/** 慢探测的上次成功结果（进程内），供非 force 时复用。 */
const slowCache = new Map()
/** checkAll 的整体结果缓存。 */
let resultCache = { at: 0, results: null }

/**
 * 查询全部平台。并行执行，整体耗时由最慢的一家决定（单家 3s 上限）。
 * @param {{ force?: boolean, ttlMs?: number }} options
 *   force: 忽略缓存并强制重测（含慢探测）；ttlMs: 结果缓存时长，默认 45s。
 */
export async function checkAll({ force = false, ttlMs = DEFAULT_TTL_MS } = {}) {
  if (!force && resultCache.results && Date.now() - resultCache.at < ttlMs) {
    return resultCache.results.map((r) => ({ ...r, cached: true }))
  }
  const settled = await Promise.allSettled(CHECKS.map((fn) => fn({ force })))
  const results = settled.map((r, i) => {
    if (r.status === 'fulfilled') return r.value
    const name = CHECKS[i].name
    return { platform: name, status: '检查异常', balance: null, note: r.reason?.message || String(r.reason) }
  })
  resultCache = { at: Date.now(), results }
  return results
}

/** 清空缓存（测试与手动重测用）。 */
export function resetCache() {
  resultCache = { at: 0, results: null }
  slowCache.clear()
  credGetter = null
}

/* 仅在直接执行本文件时跑 CLI；被 import 时不产生副作用。 */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const results = await checkAll({ force: true })
  if (JSON_OUT) {
    console.log(JSON.stringify({ checkedAt: new Date().toISOString(), results }, null, 2))
  } else {
    console.log(`=== 平台余额与状态（${new Date().toLocaleString('zh-CN')}）===\n`)
    for (const r of results) {
      console.log(`${r.platform.padEnd(16)} ${String(r.status).padEnd(26)} ${r.balance || '—'}`)
      if (r.note) console.log(`${' '.repeat(16)} └ ${r.note}`)
    }
    console.log('\n注：本脚本只读、不产生费用；查不到余额的平台一律标注"需人工查"，不猜数字。')
  }
}
