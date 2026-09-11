/**
 * DSH 成本管理插件（dsh/index.js）
 *
 * 目标（对应 skill 全生命周期第③部分"成本管理插件化"）：
 *   1) 注册 4 个工具给 Agent 自动调用：cost_status / cost_stats / cost_report / cost_models
 *   2) 读 ctx.llm 拿用户「绑定的模型」，并和本地价目表（catalog）对齐 → 适配用户自身配置
 *   3) 复用 sessions.mjs 自动扫描用户会话，做任务/模型/时间的用量统计
 *   4) 防死：cost_status 里带「硬地板 + 切换建议」，欠费时主动提示
 *
 * 设计约束（踩坑沉淀）：
 *   - inject 只声明 ['tools','llm']，apply 里不做跨服务访问（避免"inactive context"）。
 *   - 核心逻辑（余额/会话/价目）在本包外（balances.mjs / sessions.mjs / catalog.json），
 *     本地开发用相对路径引用；发布到市场前需把核心内联进本包（files 里带上）。
 *   - 工具 execute 返回纯文本（不依赖 dsh 的 output.schema 渲染面），降低对内核版本的耦合。
 *   - 会话扫描走 scanSessionsAsync()（异步 + mtime 增量 + TTL 缓存）：同步版会在 host 事件循环里
 *     阻塞约 3 秒，把整个 harness 冻住；异步 + 缓存后稳态只需几十毫秒。
 *   - 余额走 checkAll({ force })：默认命中 45s 缓存，单家 3s 超时；面板"刷新"按钮传 force 重测。
 */

import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync, existsSync } from 'node:fs'
import { renderCostPage } from './page.js'
import { renderBoardPage } from './board.js'
import { checkLoopback } from './loopback.js'

const HERE = dirname(fileURLToPath(import.meta.url))
// 核心模块已内联进本包（lib/core + lib/core/data），发布后自包含、无外部相对路径依赖。
// 与 CLI 侧同源文件的同步：运行 sync-core.mjs（把 cost-check/balances.mjs、cost-manager/{sessions,catalog,ledger,config} 复制进 lib/core）。
const BALANCES = pathToFileURL(join(HERE, 'core', 'balances.mjs')).href
const SESSIONS = pathToFileURL(join(HERE, 'core', 'sessions.mjs')).href
const PRICING = pathToFileURL(join(HERE, 'core', 'pricing.mjs')).href
const CATALOG = join(HERE, 'core', 'data', 'catalog.json')

/**
 * 实付记账（账 B）文件位置。账号数据不能进包（sync-core 会剔除 ledger.jsonl），
 * 所以运行时按优先级找一个真实存在的：
 *   1) COST_LEDGER 环境变量显式指定
 *   2) 包内 data/ledger.jsonl（发布版：用户自己运行时生成）
 *   3) 本地开发布局 ../../ledger.jsonl（即 工具/cost-manager/ledger.jsonl）
 */
function ledgerPath() {
  const candidates = [
    process.env.COST_LEDGER,
    join(HERE, 'core', 'data', 'ledger.jsonl'),
    join(HERE, '..', '..', 'ledger.jsonl'),
  ].filter(Boolean)
  for (const p of candidates) {
    try {
      if (existsSync(p)) return p
    } catch {
      /* ignore */
    }
  }
  return null
}

export const name = 'cost-manager'
// webServer 用于给 UI 面板提供 JSON 数据路由（client 半区 fetch 它）
export const inject = ['tools', 'llm', 'webServer']

function readCatalog() {
  if (!existsSync(CATALOG)) return { models: [], recipes: [] }
  return JSON.parse(readFileSync(CATALOG, 'utf8'))
}

function readLedger() {
  const p = ledgerPath()
  if (!p) return []
  try {
    return readFileSync(p, 'utf8')
      .split(/\r?\n/)
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l))
  } catch {
    return []
  }
}

/** 汇总实付记账：总额、笔数、待补笔数、按平台分布（口径见面板脚注：与账 A 不可相加）。 */
function ledgerSummary() {
  const rows = readLedger()
  const byPlatform = new Map()
  let total = 0
  let pending = 0
  for (const r of rows) {
    const cost = typeof r.cost === 'number' ? r.cost : null
    if (cost === null) pending++
    else total += cost
    const key = r.platform || '(未填平台)'
    const b = byPlatform.get(key) || { platform: key, count: 0, cost: 0, pending: 0 }
    b.count++
    if (cost === null) b.pending++
    else b.cost += cost
    byPlatform.set(key, b)
  }
  return {
    path: ledgerPath(),
    count: rows.length,
    total,
    pending,
    byPlatform: [...byPlatform.values()].sort((a, b) => b.cost - a.cost),
  }
}

/** 读用户绑定的模型：ctx.llm.listProviders() → listModels()。拿不到就返回空，不抛。 */
function boundModels(ctx) {
  const out = []
  try {
    if (typeof ctx.llm?.listProviders !== 'function') return out
    for (const p of ctx.llm.listProviders()) {
      const pid = typeof p === 'string' ? p : p.id
      let models = []
      try {
        models = ctx.llm.listModels(pid) || []
      } catch {
        models = []
      }
      for (const m of models) {
        const mid = typeof m === 'string' ? m : m.id || m.name
        out.push({ provider: pid, model: mid, name: typeof m === 'object' ? m.name : mid })
      }
    }
  } catch {
    /* 保守：绑定模型列表失败就不输出模型维度，但其余工具仍可用 */
  }
  return out
}

function fmtT(n) {
  return n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}K` : `${n}`
}

function cnyOf(balance) {
  const n = parseFloat(String(balance || '').match(/¥([\d.]+)/)?.[1])
  return Number.isFinite(n) ? n : null
}

async function toolStatus(config, options = {}) {
  const { checkAll } = await import(BALANCES)
  const { scanSessionsAsync } = await import(SESSIONS)
  const { computeBurn, humanHours } = await import(PRICING)
  const results = await checkAll({ force: options.force === true })
  const lines = ['平台余额与状态：']
  for (const r of results) {
    const floor = config.balanceFloor?.[r.platform]
    const balNum = cnyOf(r.balance)
    const belowFloor = floor !== undefined && balNum !== null && balNum < floor
    lines.push(`- ${r.platform}: ${r.balance || '—'} ${r.status}${belowFloor ? ` ⛔低于硬地板¥${floor}（停烧，先充值或切换）` : ''}`)
  }

  // 防死预测：不只报余额，还报"照这个速度还能撑多久"
  try {
    const burn = computeBurn((await scanSessionsAsync()).messages, readCatalog(), config)
    if (burn.byPlatform?.length) {
      lines.push('')
      lines.push(`消耗速率（最近 ${burn.windowHours}h 窗口 · 活跃跨度 ${burn.spanHours.toFixed(1)}h，按 token 单价估费）：`)
      for (const b of burn.byPlatform.sort((x, y) => y.ratePerHour - x.ratePerHour)) {
        const row = results.find((r) => r.platform === b.platform)
        const bal = row ? cnyOf(row.balance) : null
        const floor = config.balanceFloor?.[b.platform]
        let tail = ''
        if (bal !== null && b.ratePerHour > 0 && floor !== undefined) {
          const hours = (bal - floor) / b.ratePerHour
          tail = `　→ 距硬地板¥${floor}还可撑约 ${humanHours(hours)}${hours < 2 ? ' ⚠️不足2小时，建议充值或改用 flash（比 pro 便宜约 18 倍）' : ''}`
        }
        lines.push(`- ${b.platform}: ¥${b.ratePerHour.toFixed(2)}/h${tail}`)
      }
    }
  } catch {
    /* 预测失败不影响余额展示 */
  }

  lines.push('')
  lines.push('切换建议：DeepSeek 见底 → Kimi/GLM；图像 → MXAPI；配音 → edge-tts。')
  return lines.join('\n')
}

async function toolStats(args, config) {
  const { scanSessionsAsync } = await import(SESSIONS)
  const { estimateCost } = await import(PRICING)
  const { messages } = await scanSessionsAsync()
  const catalog = readCatalog()
  const group = args?.group || 'model'
  const from = args?.from
  const to = args?.to
  const taskKw = args?.task
  const modelKw = args?.model
  const rows = messages.filter((m) => {
    if (from && m.day < from) return false
    if (to && m.day > to) return false
    if (taskKw && !m.session.includes(taskKw)) return false
    if (modelKw && !`${m.provider}/${m.model}`.toLowerCase().includes(String(modelKw).toLowerCase())) return false
    return true
  })
  // 分组保留消息列表：估费按模型单价分价（pro/flash 价差 18 倍，不能只存 token 总和）
  const groups = new Map()
  for (const m of rows) {
    const k = group === 'day' ? m.day : group === 'task' ? m.session : `${m.provider}/${m.model}`
    const arr = groups.get(k) || []
    arr.push(m)
    groups.set(k, arr)
  }
  const totTok = (arr) => arr.reduce((s, m) => s + m.inTokens + m.outTokens + m.reasoningTokens, 0)
  const lines = [`会话用量（按${group === 'day' ? '日期' : group === 'task' ? '任务' : '模型'}，共 ${rows.length} 条消息 · 估费按模型单价分价）：`]
  for (const [k, arr] of [...groups.entries()].sort((x, y) => totTok(y[1]) - totTok(x[1])).slice(0, 20)) {
    lines.push(`- ${String(k).slice(0, 48)}: ${arr.length} 条 · ${fmtT(totTok(arr))} token · 估费 ¥${estimateCost(arr, catalog, config).toFixed(2)}`)
  }
  lines.push(`合计估费：¥${estimateCost(rows, catalog, config).toFixed(2)}`)
  return lines.join('\n')
}

function toolReport(args) {
  const days = args?.days ? Number(args.days) : 30
  const since = Date.now() - days * 86400000
  const rows = readLedger().filter((r) => new Date(r.ts).getTime() >= since)
  if (rows.length === 0) return `最近 ${days} 天没有记账记录`
  const total = rows.reduce((s, r) => s + (r.cost || 0), 0)
  const byP = new Map()
  for (const r of rows) byP.set(r.platform, (byP.get(r.platform) || 0) + (r.cost || 0))
  const lines = [`最近 ${days} 天花费合计 ¥${total.toFixed(2)}（${rows.length} 笔）：`]
  for (const [p, c] of [...byP.entries()].sort((a, b) => b[1] - a[1])) lines.push(`- ${p}: ¥${c.toFixed(2)}`)
  return lines.join('\n')
}

function toolModels(ctx) {
  const catalog = readCatalog()
  const bound = boundModels(ctx)
  const byId = new Map(catalog.models.map((m) => [`${m.platform}/${m.id}`, m]))
  const lines = [`你绑定的模型（${bound.length} 个）与价目对齐：`]
  const srcLabel = (s) => (s === 'measured' ? '实测' : s === 'official' ? '官方价' : s === 'estimate' ? '估算' : '待测')
  for (const b of bound) {
    const hit =
      byId.get(`${b.provider}/${b.model}`) ||
      catalog.models.find((m) => m.id === b.model) ||
      catalog.models.find((m) => m.id && b.model && b.model.includes(m.id))
    if (hit && hit.price !== null && hit.price !== undefined) {
      lines.push(`- ${b.provider}/${b.model}: ¥${hit.price}/${hit.unit}（${srcLabel(hit.priceSource)}）· ${(hit.scenes || []).join('、')}`)
    } else if (hit) {
      lines.push(`- ${b.provider}/${b.model}: 已登记·单价待测（${hit.unit}）· ${(hit.scenes || []).join('、')}`)
    } else {
      lines.push(`- ${b.provider}/${b.model}: 未在价目表（待补价）`)
    }
  }
  lines.push('')
  lines.push('（价目表共 ' + catalog.models.length + ' 个模型/工具；"实测/官方价/估算"已标注来源）')
  return lines.join('\n')
}

export function apply(ctx) {
  const config = (() => {
    try {
      return JSON.parse(readFileSync(join(HERE, 'core', 'data', 'config.json'), 'utf8'))
    } catch {
      return { budgetCapCny: 5, tokenRateCnyPer1M: 5, balanceFloor: { DeepSeek: 8, 'Kimi (Moonshot)': 5 } }
    }
  })()

  const tools = [
    {
      name: 'cost_status',
      description: '查询各 AI 平台的余额与状态，含欠费硬地板提示与切换建议。当你或用户想知道"还剩多少钱、会不会欠费、该不该换模型"时使用。',
      parameters: { type: 'object', properties: {} },
      execute: async () => toolStatus(config),
    },
    {
      name: 'cost_stats',
      description: '统计本机 DSH 会话的 token 用量，可按 group=model|task|day 分组，并支持 from/to（日期）、task（任务关键词）、model（模型关键词）筛选。用于"哪个任务/模型/时间段花了多少"。',
      parameters: {
        type: 'object',
        properties: {
          group: { type: 'string', description: 'model | task | day，默认 model' },
          from: { type: 'string', description: '起始日期 YYYY-MM-DD' },
          to: { type: 'string', description: '结束日期 YYYY-MM-DD' },
          task: { type: 'string', description: '任务名关键词' },
          model: { type: 'string', description: '模型名关键词' },
        },
      },
      execute: async (args) => toolStats(args || {}, config),
    },
    {
      name: 'cost_report',
      description: '汇总最近的花费账本（图片/视频/数字人等实付项），按平台聚合计费。',
      parameters: { type: 'object', properties: { days: { type: 'number', description: '最近 N 天，默认 30' } } },
      execute: async (args) => toolReport(args || {}),
    },
    {
      name: 'cost_models',
      description: '列出用户当前绑定的模型，并与本地价目表（单价/价格来源/擅长场景）对齐，用于选型与报价。',
      parameters: { type: 'object', properties: {} },
      execute: async () => toolModels(ctx),
    },
  ]

  for (const t of tools) {
    try {
      ctx.tools.register(t)
    } catch (error) {
      console.error(`[cost-manager] ${t.name} 注册失败：${error?.message || error}`)
    }
  }

  // UI 数据通路：给设置页面板注册 JSON 路由（浏览器半区 fetch 它）
  registerUiRoute(ctx, config)
}

/** 组装 UI 面板数据：余额 + 硬地板 + 消耗速率（含可撑时长所需的原始值）+ LLM 用量 */
export async function buildOverview(config, options = {}) {
  const force = options.force === true
  const { checkAll } = await import(BALANCES)
  const { scanSessionsAsync } = await import(SESSIONS)
  const { computeBurn, estimateCost } = await import(PRICING)
  const catalog = readCatalog()

  // 余额探测与会话扫描互不依赖 → 同时启动，首屏耗时取两者较大值而不是相加（实测 8.5s → ~5s）
  const balancesPromise = checkAll({ force })
  const scanPromise = scanSessionsAsync({ force }).catch(() => null)

  const balances = await balancesPromise
  const scanned = await scanPromise

  let burn = { windowHours: 6, spanHours: 0, byPlatform: [] }
  let usage = { cost: 0, tokens: 0, msgs: 0 }
  let scan = { cached: null, reparsedFiles: null, reusedFiles: null, scannedAt: null }
  if (scanned) {
    const { messages } = scanned
    burn = computeBurn(messages, catalog, config)
    usage = {
      cost: estimateCost(messages, catalog, config),
      tokens: messages.reduce((s, m) => s + m.inTokens + m.outTokens + m.reasoningTokens, 0),
      msgs: messages.length,
    }
    scan = {
      cached: scanned.cached,
      reparsedFiles: scanned.reparsedFiles,
      reusedFiles: scanned.reusedFiles,
      scannedAt: scanned.scannedAt,
      failedFiles: (scanned.failures || []).length,
      failures: (scanned.failures || []).slice(0, 3),
    }
  }

  return {
    ok: true,
    updatedAt: new Date().toISOString(),
    servedAt: Date.now(),
    forced: force,
    balances,
    floors: config.balanceFloor || {},
    alerts: config.lowBalanceAlert || {},
    burn,
    usage,
    scan,
    ledger: ledgerSummary(),
  }
}

function writeJson(res, obj, status = 200) {
  const body = JSON.stringify(obj)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

function registerUiRoute(ctx, config) {
  if (typeof ctx.webServer?.register !== 'function') {
    console.error('[cost-manager] webServer 服务不可用，UI 面板数据路由未注册')
    return
  }
  /**
   * loopback 围栏：插件路由不在 DSH 外壳的鉴权门后面，必须自行校验来源。
   * 不是本机请求就回 403 并返回 true，调用方直接 return。
   * 详见 lib/loopback.js（DNS rebinding / 局域网暴露）。
   */
  const denyNonLoopback = (req, res) => {
    const guard = checkLoopback(req)
    if (guard.ok) return false
    writeJson(res, { error: 'forbidden: loopback-only', detail: guard.reason }, 403)
    return true
  }
  try {
    ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-cost/api/overview',
      handler: async (req, res) => {
        if (denyNonLoopback(req, res)) return
        try {
          // force=1：绕过余额/会话两层缓存强制重测（面板"刷新"按钮用）
          let force = false
          try {
            force = new URL(req.url || '/', 'http://localhost').searchParams.get('force') === '1'
          } catch {
            force = false
          }
          writeJson(res, await buildOverview(config, { force }))
        } catch (error) {
          writeJson(res, { ok: false, error: String(error?.message || error) }, 500)
        }
      },
    })
  } catch (error) {
    console.error(`[cost-manager] UI 路由注册失败：${error?.message || error}`)
  }

  // 3082 上的实时总览页（替代原来单独进程的 `cost.mjs serve` → 8899）
  for (const path of ['/cost', '/cost/']) {
    try {
      ctx.webServer.register({
        kind: 'exact',
        path,
        handler: (req, res) => {
          if (denyNonLoopback(req, res)) return
          const body = renderCostPage()
          res.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            'content-length': Buffer.byteLength(body),
            'cache-control': 'no-store',
          })
          res.end(body)
        },
      })
    } catch (error) {
      console.error(`[cost-manager] 总览页路由注册失败 ${path}：${error?.message || error}`)
    }
  }

  // 运维看板：一个地址两个页签，把 /cost 与 /dshm 合到同一浏览器标签（iframe 同源嵌入）
  for (const path of ['/board', '/board/']) {
    try {
      ctx.webServer.register({
        kind: 'exact',
        path,
        handler: (req, res) => {
          if (denyNonLoopback(req, res)) return
          const body = renderBoardPage()
          res.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            'content-length': Buffer.byteLength(body),
            'cache-control': 'no-store',
          })
          res.end(body)
        },
      })
    } catch (error) {
      console.error(`[cost-manager] 看板路由注册失败 ${path}：${error?.message || error}`)
    }
  }
}
