#!/usr/bin/env node
/**
 * sessions —— 从 DSH 会话文件自动提取「任务 / 模型 / 时间 / token」用量。
 *
 * 数据来源：$DSH_HOME/sessions/<目录>/session.jsonl.zstd
 *   （默认 ~/.toa3/harness-runtime/.dsh；跟随 DSH_HOME 环境变量）
 *   - 每个会话 = 一个 zstd 压缩的 JSONL，含 session 头、turn/start、assistant/message（带 usage）、session/title 等。
 *   - usage 字段：assistant/message 顶层 `usage:{inputTokens,outputTokens,reasoningTokens,cacheReadTokens}`，
 *     source 字段：`data.message.source:{provider,model}`，title：`session/title`。
 *
 * 关键实现：文件是"多帧 zstd"（dsh 边写边追加压缩帧），且**记录可能跨帧**。
 *   因此不能按帧换行拼接，必须**把各帧解压后的字节直接首尾相接**，再按换行切分——这样跨帧记录才能还原。
 *
 * 用法：
 *   node sessions.mjs                 扫描全部会话，打印聚合（任务/模型/日）
 *   node sessions.mjs --json          机器可读
 *   node sessions.mjs --write usage.jsonl   把每条 assistant/message 用量写进 usage.jsonl
 *
 * 两套入口（性能）：
 *   scanSessions()      同步，保持历史行为，给 CLI / cost.mjs 用。
 *   scanSessionsAsync() 异步 + TTL 缓存 + mtime 增量，给长驻的 DSH 插件用。
 *
 *   为什么要异步版：同步版用 readFileSync + zstdDecompressSync 扫全部会话（实测 3.3s），
 *   而插件跑在 DSH host 的同一个事件循环里，那 3.3s 会把整个 harness（含正在流式输出的
 *   会话）一起冻住。异步版把这段时间让出去；增量 + 缓存让稳态耗时降到几十毫秒。
 */

import zlib from 'node:zlib'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** 会话根目录：跟随 DSH_HOME，缺省回落到历史默认路径。 */
export const SESSIONS_ROOT = process.env.DSH_HOME
  ? path.join(process.env.DSH_HOME, 'sessions')
  : path.join(process.env.USERPROFILE || '', '.toa3', 'harness-runtime', '.dsh', 'sessions')

const JSON_OUT = process.argv.includes('--json')
const WRITE = process.argv.includes('--write')

/** scanSessionsAsync 的结果缓存时长（毫秒）。 */
const DEFAULT_TTL_MS = Number(process.env.COST_SESSIONS_TTL_MS || 30000)

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd]

/** 按 zstd magic 切出多帧边界。 */
function splitFrames(buf) {
  const frames = []
  let start = -1
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf[i] === ZSTD_MAGIC[0] && buf[i + 1] === ZSTD_MAGIC[1] && buf[i + 2] === ZSTD_MAGIC[2] && buf[i + 3] === ZSTD_MAGIC[3]) {
      if (start >= 0) frames.push(buf.subarray(start, i))
      start = i
    }
  }
  if (start >= 0) frames.push(buf.subarray(start))
  return frames
}

/** 解压多帧 zstd 文件（同步），返回完整的 JSONL 文本（跨帧记录也能还原）。 */
function decompressSessionSync(file) {
  const buf = fs.readFileSync(file)
  const parts = []
  for (const fr of splitFrames(buf)) {
    try {
      parts.push(zlib.zstdDecompressSync(fr))
    } catch {
      /* 尾部不完整帧（活文件正在写入）忽略 */
    }
  }
  return Buffer.concat(parts).toString('utf8') // 关键：字节直拼，不插换行
}

/**
 * 异步版解压：不再阻塞事件循环。
 *
 * 两个必须踩到的坑：
 *  1) node:zlib 的异步 API 是**回调式**（`zlib.zstdDecompress(buf, cb)`），
 *     直接 `await zlib.zstdDecompress(buf)` 会抛 ERR_INVALID_ARG_TYPE，必须 promisify。
 *  2) dsh 的会话文件是"每写一次追加一帧"，实测 9 个会话共 **7.3 万帧**（单文件最多 6 万帧）；
 *     而且 Node 的 zstd **只解第一帧**（整体解压和 createZstdDecompress 流式都实测只出 203 字节），
 *     所以必须逐帧解。串行 await 每帧一次线程池往返 → 5.7s；给到 16 并发后 4.0s，
 *     与同步版 3.7s 基本持平，但把这段时间让出了事件循环。
 *
 * 也刻意**不再静默吞掉全部错误**：只有尾部不完整帧（活文件正在写入）是正常的；
 * 全部帧都失败说明环境/用法有问题，必须抛出来，否则会静默统计成 0 条。
 */
const zstdDecompressAsync = typeof zlib.zstdDecompress === 'function' ? promisify(zlib.zstdDecompress) : null
const FRAME_CONCURRENCY = Number(process.env.COST_FRAME_CONCURRENCY || 16)

async function decompressFrames(frames) {
  const parts = new Array(frames.length)
  let failed = 0
  let cursor = 0
  const worker = async () => {
    while (cursor < frames.length) {
      const i = cursor++
      try {
        parts[i] = await zstdDecompressAsync(frames[i])
      } catch {
        parts[i] = null // 尾部不完整帧：正常（文件正在被写入）
        failed++
      }
    }
  }
  const lanes = Math.max(1, Math.min(FRAME_CONCURRENCY, frames.length))
  await Promise.all(Array.from({ length: lanes }, worker))
  const usable = parts.filter(Boolean) // 保序拼接（按索引写回，filter 不乱序）
  if (usable.length === 0 && frames.length > 0) {
    throw new Error(`全部 ${failed} 帧解压失败（首次失败：${failed ? '见上' : '无帧'}）`)
  }
  return Buffer.concat(usable)
}

async function decompressSession(file) {
  const buf = await fsp.readFile(file)
  const frames = splitFrames(buf)
  if (frames.length === 0) return ''
  if (!zstdDecompressAsync) return decompressSessionSync(file) // 老 Node 无异步 zstd：退回同步，至少不丢数据
  const out = await decompressFrames(frames)
  if (out.length === 0) throw new Error(`解压结果为空：${path.basename(path.dirname(file))}（${frames.length} 帧）`)
  return out.toString('utf8')
}

function findSessionFilesSync(dir) {
  const out = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...findSessionFilesSync(p))
    else if (e.name === 'session.jsonl.zstd') out.push(p)
  }
  return out
}

async function findSessionFiles(dir) {
  const out = []
  let entries = []
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...(await findSessionFiles(p)))
    else if (e.name === 'session.jsonl.zstd') out.push(p)
  }
  return out
}

/**
 * 解析**单个会话文件**的 JSONL 文本 → { session, messages }。
 * 拆成"按文件"是为了让增量扫描能只重算变化的文件。
 */
export function parseSessionText(text) {
  let title = '(无标题)'
  let cwd = ''
  let first = null
  let last = null
  const turns = new Set()
  let msgs = 0
  let inT = 0
  let outT = 0
  let reason = 0
  let cacheR = 0
  let usageFound = 0
  const messages = []

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    let r
    try {
      r = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof r.time === 'number') {
      first = first === null ? r.time : Math.min(first, r.time)
      last = Math.max(last, r.time)
    }
    if (r.type === 'session') cwd = r.cwd || cwd
    if (r.type === 'session/title') title = r.data?.title || title
    if (r.type === 'turn/start') turns.add(r.data?.turn)
    if (r.type !== 'assistant/message') continue

    msgs++
    const src = r.data?.message?.source || r.source
    const u = r.data?.usage // 注意：usage 在 data 里，不在顶层
    const inTok = u?.inputTokens || 0
    const outTok = u?.outputTokens || 0
    const reasonTok = u?.reasoningTokens || 0
    const cacheTok = u?.cacheReadTokens || 0
    if (u) usageFound++
    inT += inTok
    outT += outTok
    reason += reasonTok
    cacheR += cacheTok

    const provider = src?.provider || '?'
    const model = src?.model || '?'
    const day = new Date(r.time).toISOString().slice(0, 10)

    messages.push({
      ts: r.time,
      day,
      session: title,
      cwd,
      turn: r.data?.turn,
      provider,
      model,
      inTokens: inTok,
      outTokens: outTok,
      reasoningTokens: reasonTok,
      cacheReadTokens: cacheTok,
      usageFound: Boolean(u), // 聚合 byModel.usageFound 用；对下游（pricing/usage.jsonl）是附加字段
    })
  }

  return {
    session: { title, cwd, turns: turns.size, msgs, usageFound, inT, outT, reason, cacheR, first, last },
    messages,
  }
}

/** 把各个会话文件的解析结果聚合为 scanSessions 的返回形状。 */
export function aggregate(parts) {
  const sessions = []
  const byModel = new Map()
  const byDay = new Map()
  const messages = []

  for (const part of parts) {
    if (!part) continue
    const s = part.session
    sessions.push(s)
    for (const m of part.messages) {
      messages.push(m)
      const key = `${m.provider}/${m.model}`
      const b = byModel.get(key) || { provider: m.provider, model: m.model, msgs: 0, inT: 0, outT: 0, reason: 0, cacheR: 0, usageFound: 0 }
      b.msgs++
      b.inT += m.inTokens
      b.outT += m.outTokens
      b.reason += m.reasoningTokens
      b.cacheR += m.cacheReadTokens
      if (m.usageFound) b.usageFound++
      byModel.set(key, b)

      const d = byDay.get(m.day) || { inT: 0, outT: 0, reason: 0, msgs: 0 }
      d.inT += m.inTokens
      d.outT += m.outTokens
      d.reason += m.reasoningTokens
      d.msgs++
      byDay.set(m.day, d)
    }
  }

  sessions.sort((a, b) => a.first - b.first)
  return {
    sessions,
    byModel: [...byModel.values()],
    byDay: [...byDay.entries()].map(([day, v]) => ({ day, ...v })),
    messages,
  }
}

/** 同步扫描（历史行为，CLI / cost.mjs 用）。返回 { sessions, byModel, byDay, messages }。 */
export function scanSessions(root = SESSIONS_ROOT) {
  const files = findSessionFilesSync(root)
  const parts = []
  for (const file of files) parts.push(parseSessionText(decompressSessionSync(file)))
  return aggregate(parts)
}

/** scanSessionsAsync 的进程内缓存：文件签名 → 已解析结果。 */
let CACHE = { root: null, at: 0, files: new Map(), result: null }

/**
 * 异步 + 缓存 + 增量扫描（长驻插件用）。
 * @param {{ root?: string, force?: boolean, ttlMs?: number }} options
 *   force: 忽略整体缓存；ttlMs: 整体缓存时长，默认 30s。
 * @returns {Promise<{sessions, byModel, byDay, messages, cached, scannedAt, reparsedFiles, reusedFiles}>}
 */
export async function scanSessionsAsync({ root = SESSIONS_ROOT, force = false, ttlMs = DEFAULT_TTL_MS } = {}) {
  const now = Date.now()
  if (!force && CACHE.result && CACHE.root === root && now - CACHE.at < ttlMs) {
    return { ...CACHE.result, cached: true, scannedAt: CACHE.at, reparsedFiles: 0, reusedFiles: CACHE.files.size, failures: CACHE.failures ?? [] }
  }

  const files = await findSessionFiles(root)
  const prev = CACHE.root === root ? CACHE.files : new Map()
  const next = new Map()
  const parts = []
  const failures = []
  let reparsed = 0
  let reused = 0

  for (const file of files) {
    let sig = null
    try {
      const st = await fsp.stat(file)
      sig = `${Math.round(st.mtimeMs)}:${st.size}`
    } catch {
      sig = null // 读不到签名（文件刚被清掉）→ 走重解析
    }
    const hit = sig !== null ? prev.get(file) : null
    if (hit && hit.sig === sig) {
      next.set(file, hit)
      parts.push(hit.parsed)
      reused++
      continue
    }
    let parsed
    try {
      parsed = parseSessionText(await decompressSession(file))
    } catch (error) {
      // 单个会话读不出来不该让整块面板归零；记下来暴露给调用方，并且**不缓存失败**（下次重试）
      failures.push({ session: path.basename(path.dirname(file)), error: String(error?.message || error) })
      reparsed++
      continue
    }
    next.set(file, { sig, parsed })
    parts.push(parsed)
    reparsed++
  }

  const result = aggregate(parts)
  CACHE = { root, at: Date.now(), files: next, result, failures }
  return { ...result, cached: false, scannedAt: CACHE.at, reparsedFiles: reparsed, reusedFiles: reused, failures }
}

/** 清空缓存（测试与强制重算用）。 */
export function resetCache() {
  CACHE = { root: null, at: 0, files: new Map(), result: null }
}

function fmt(n) {
  return n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}K` : `${n}`
}

function main() {
  const { sessions, byModel, byDay, messages } = scanSessions()
  const totalIn = sessions.reduce((a, s) => a + s.inT, 0)
  const totalOut = sessions.reduce((a, s) => a + s.outT, 0)
  const totalReason = sessions.reduce((a, s) => a + s.reason, 0)
  const usageFound = sessions.reduce((a, s) => a + s.usageFound, 0)
  const msgCount = sessions.reduce((a, s) => a + s.msgs, 0)

  if (JSON_OUT) {
    console.log(JSON.stringify({ totalIn, totalOut, totalReason, msgCount, usageFound, sessions, byModel, byDay }, null, 2))
    return
  }

  console.log(`=== DSH 会话用量（${sessions.length} 个会话）===\n`)
  console.log(`消息 ${msgCount} 条，其中带 usage 的 ${usageFound} 条`)
  console.log(`token：输入 ${fmt(totalIn)} · 输出 ${fmt(totalOut)} · 思考 ${fmt(totalReason)}\n`)

  console.log('— 按模型 —')
  for (const m of byModel.sort((a, b) => b.inT - a.inT)) {
    console.log(`  ${m.provider}/${m.model.padEnd(26)} msgs ${String(m.msgs).padStart(4)} 入 ${fmt(m.inT).padStart(8)} 出 ${fmt(m.outT).padStart(8)} 思考 ${fmt(m.reason)}`)
  }

  console.log('\n— 按天 —')
  for (const d of byDay.sort((a, b) => a.day.localeCompare(b.day))) {
    console.log(`  ${d.day}  msgs ${String(d.msgs).padStart(4)} 入 ${fmt(d.inT).padStart(8)} 出 ${fmt(d.outT).padStart(8)} 思考 ${fmt(d.reason)}`)
  }

  console.log('\n— 按任务（会话）—')
  for (const s of sessions) {
    const d = s.first ? new Date(s.first).toLocaleDateString('zh-CN') : '?'
    console.log(`  [${d}] ${s.title.slice(0, 18).padEnd(18)} turn=${String(s.turns).padEnd(3)} 入 ${fmt(s.inT).padStart(8)} 出 ${fmt(s.outT).padStart(8)} (${(s.cwd || '').split(/[\\/]/).pop()})`)
  }

  if (WRITE) {
    const out = path.join(HERE, 'usage.jsonl')
    fs.writeFileSync(out, messages.map((m) => JSON.stringify(m)).join('\n') + '\n')
    console.log(`\n已写每条用量到：${out}（${messages.length} 条）`)
  }
}

/* 仅在直接执行本文件时跑 CLI；被 import 时不产生副作用。 */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
