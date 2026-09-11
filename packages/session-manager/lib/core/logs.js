import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { zstdDecompress, zstdDecompressSync } from "node:zlib";
import { promisify } from "node:util";
import { loadStore } from "./store.js";

// ---------------------------------------------------------------------------
// 会话日志（session.jsonl.zstd）读取层。Harness 用「一个 header frame + 每批
// append 一个 frame」的 Zstandard 帧拼接存储；Node 的 zstd 只解第一个 frame，
// 因此按 magic 字节切帧后逐个解压。JSONL 内关键事件：
//   - user/message（source.kind === 'user' 为人类输入）
//   - assistant/message（含 data.message.content 与 data.usage 每步 token）
//
// 性能约定（网页端用）：
//   1) 帧数极大：实测 9 个会话共 7.3 万帧（单文件最多 6 万帧），逐帧解压是主要成本
//      （约 2.6s），JSON 解析只占 0.3s。所以：
//      - 异步路径用 promisify(zstdDecompress) + 有限并发，把这段时间让出事件循环
//        （单线程 http 服务里，同步解压会把整个页面堵住）；
//      - 结果按「文件 mtime+size」缓存成 transcript + trend，命中即 0ms。
//   2) 会话 id → 日志路径做成一次遍历的索引，避免每个会话都重走一遍目录树。
//   3) 同步 API 全部保留（CLI 一次性调用用），与异步 API 共享同一份缓存。
// ---------------------------------------------------------------------------

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]); // zstd frame magic

/** 异步解压并发度（帧数巨大，串行 await 的线程池往返开销会把 2.6s 拖到 5.7s）。 */
const FRAME_CONCURRENCY = Number(process.env.DSHM_FRAME_CONCURRENCY || 16);
const zstdAsync = promisify(zstdDecompress);

/** transcript 缓存总字符预算（超出按 LRU 淘汰；可用 DSHM_LOG_CACHE_CHARS 调整）。 */
const CACHE_MAX_CHARS = Number(process.env.DSHM_LOG_CACHE_CHARS || 80_000_000);

/** 切出各 zstd 帧的边界偏移。 */
function frameOffsets(buf) {
  const offs = [0];
  let i = 4;
  while ((i = buf.indexOf(MAGIC, i)) !== -1) {
    offs.push(i);
    i += 4;
  }
  offs.push(buf.length);
  return offs;
}

/** 解压一个 .jsonl.zstd（或透传 .jsonl）。同步版：CLI 用。 */
export function readSessionLog(filePath) {
  const buf = readFileSync(filePath);
  if (!filePath.endsWith(".zstd")) return buf.toString("utf8");
  const offs = frameOffsets(buf);
  let out = "";
  for (let k = 0; k < offs.length - 1; k++) {
    out += zstdDecompressSync(buf.subarray(offs[k], offs[k + 1])).toString("utf8");
  }
  return out;
}

/**
 * 异步版：逐帧解压但带有限并发，不阻塞事件循环。
 * 尾部不完整帧（活文件正在写入）允许失败；全部帧失败才算错误（否则会静默变成空数据）。
 */
async function readSessionLogAsync(filePath, buf) {
  if (!filePath.endsWith(".zstd")) return buf.toString("utf8");
  const offs = frameOffsets(buf);
  const frames = [];
  for (let k = 0; k < offs.length - 1; k++) frames.push(buf.subarray(offs[k], offs[k + 1]));

  const parts = new Array(frames.length);
  let failed = 0;
  let cursor = 0;
  const worker = async () => {
    while (cursor < frames.length) {
      const i = cursor++;
      try {
        parts[i] = await zstdAsync(frames[i]);
      } catch {
        parts[i] = null;
        failed++;
      }
    }
  };
  const lanes = Math.max(1, Math.min(FRAME_CONCURRENCY, frames.length));
  await Promise.all(Array.from({ length: lanes }, worker));

  const usable = parts.filter(Boolean);
  if (usable.length === 0 && frames.length > 0) {
    throw new Error(`全部 ${failed} 帧解压失败：${filePath}`);
  }
  return Buffer.concat(usable).toString("utf8");
}

// ---------------------------------------------------------------------------
// 会话 id → 日志文件路径索引（一次遍历，带短 TTL）
// ---------------------------------------------------------------------------

let indexCache = { home: null, at: 0, map: null };
const INDEX_TTL_MS = Number(process.env.DSHM_INDEX_TTL_MS || 15000);

/** 遍历 $DSH_HOME/sessions 得到 { sessionId -> 日志文件路径 }。 */
export function sessionLogIndex(home) {
  if (indexCache.home === home && indexCache.map && Date.now() - indexCache.at < INDEX_TTL_MS) {
    return indexCache.map;
  }
  const map = new Map();
  const root = join(home, "sessions");
  let projects;
  try {
    projects = readdirSync(root, { withFileTypes: true });
  } catch {
    indexCache = { home, at: Date.now(), map };
    return map;
  }
  for (const proj of projects) {
    if (!proj.isDirectory()) continue;
    const projDir = join(root, proj.name);
    let subs;
    try {
      subs = readdirSync(projDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const s of subs) {
      if (!s.isDirectory()) continue;
      const dir = join(projDir, s.name);
      const z = join(dir, "session.jsonl.zstd");
      if (existsSync(z)) map.set(s.name, z);
      else {
        const plain = join(dir, "session.jsonl");
        if (existsSync(plain)) map.set(s.name, plain);
      }
    }
  }
  indexCache = { home, at: Date.now(), map };
  return map;
}

/** 在 $DSH_HOME/sessions/<项目目录>/<会话目录>/ 下定位某个会话的日志文件。 */
export function findSessionLog(home, sessionId) {
  const hit = sessionLogIndex(home).get(sessionId);
  if (hit) return hit;
  // 会话刚创建、索引还没刷新时的兜底：直接扫一遍并刷新索引
  indexCache = { home: null, at: 0, map: null };
  return sessionLogIndex(home).get(sessionId) ?? null;
}

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

/** 把 JSONL 文本解析为事件数组（损坏行跳过）。 */
export function parseEventsText(text) {
  const events = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      /* skip corrupt tail */
    }
  }
  return events;
}

/** 解压并按行解析为事件数组（损坏行跳过）。 */
export function parseEvents(filePath) {
  return parseEventsText(readSessionLog(filePath));
}

// ---- 文本提取 ----
function blocks(content, type) {
  return Array.isArray(content) ? content.filter((b) => b && b.type === type) : [];
}
function joinBlocks(content, type) {
  return blocks(content, type)
    .map((b) => (typeof b.text === "string" ? b.text : ""))
    .join("\n")
    .trim();
}
function toolCallsOf(content) {
  return blocks(content, "tool-call").map((b) => ({
    id: b.id ?? null,
    name: b.name ?? null,
    arguments: b.arguments ?? b.args ?? b.input ?? null,
  }));
}

/**
 * 把一个会话的事件流折叠成有序的「可读消息」序列（供导出/搜索）。
 */
export function transcript(events) {
  const header = events.find((e) => e.type === "session") ?? null;
  let title = null;
  const messages = [];
  for (const e of events) {
    if (e.type === "session/title" && e.data?.title) title = e.data.title;
    if (e.type === "user/message" && e.data?.source?.kind === "user") {
      const text = joinBlocks(e.data.content, "text");
      if (!text) continue;
      messages.push({ role: "user", time: e.time, text });
    } else if (e.type === "assistant/message") {
      const content = e.data?.message?.content ?? [];
      const text = joinBlocks(content, "text");
      const reasoning = joinBlocks(content, "reasoning");
      const toolCalls = toolCallsOf(content);
      if (!text && !reasoning && toolCalls.length === 0) continue;
      messages.push({
        role: "assistant",
        time: e.time,
        turn: e.data?.turn ?? null,
        step: e.data?.step ?? null,
        text,
        reasoning,
        toolCalls,
        model: e.data?.message?.source?.model ?? null,
        provider: e.data?.message?.source?.provider ?? null,
        usage: e.data?.usage ?? null,
      });
    }
  }
  return { header, title, messages };
}

/** 每步 token 用量序列（来自 assistant/message 的 usage）。 */
export function trendOf(events) {
  const points = [];
  for (const e of events) {
    if (e.type !== "assistant/message") continue;
    const u = e.data?.usage ?? null;
    if (!u) continue;
    points.push({
      time: e.time,
      turn: e.data?.turn ?? null,
      step: e.data?.step ?? null,
      inputTokens: u.inputTokens ?? 0,
      outputTokens: u.outputTokens ?? 0,
      cacheReadTokens: u.cacheReadTokens ?? 0,
      cacheWriteTokens: u.cacheWriteTokens ?? 0,
      reasoningTokens: u.reasoningTokens ?? 0,
    });
  }
  return points;
}

// ---------------------------------------------------------------------------
// 按文件签名的缓存（transcript + trend），同步/异步共用
// ---------------------------------------------------------------------------

/** filePath -> { sig, entry, chars }；Map 的插入顺序即 LRU 顺序。 */
const logCache = new Map();
let cacheChars = 0;
let cacheHits = 0;
let cacheMisses = 0;

function sigSync(p) {
  try {
    const st = statSync(p);
    return `${Math.round(st.mtimeMs)}:${st.size}`;
  } catch {
    return null;
  }
}
async function sigAsync(p) {
  try {
    const st = await stat(p);
    return `${Math.round(st.mtimeMs)}:${st.size}`;
  } catch {
    return null;
  }
}

function cacheGet(path, sig) {
  const hit = logCache.get(path);
  if (!hit || !sig || hit.sig !== sig) return null;
  logCache.delete(path); // LRU touch
  logCache.set(path, hit);
  cacheHits++;
  return hit.entry;
}

/** 粗略统计任意值的字符规模（用于缓存预算，避免 JSON.stringify 的临时分配）。 */
function valueChars(v) {
  if (v == null) return 0;
  if (typeof v === "string") return v.length;
  if (Array.isArray(v)) return v.reduce((s, x) => s + valueChars(x), 0);
  if (typeof v === "object") return Object.values(v).reduce((s, x) => s + valueChars(x), 0);
  return 8;
}

function entryChars(entry) {
  let n = 0;
  for (const m of entry.transcript.messages) {
    n += (m.text ? m.text.length : 0) + (m.reasoning ? m.reasoning.length : 0);
    // 工具调用参数也要算：write/edit 这类调用的 arguments 里是整份文件内容，量级可能超过正文
    for (const tc of m.toolCalls ?? []) n += valueChars(tc.arguments);
  }
  return n;
}

function cacheSet(path, sig, entry) {
  if (logCache.has(path)) {
    cacheChars -= logCache.get(path).chars;
    logCache.delete(path);
  }
  const chars = entryChars(entry);
  logCache.set(path, { sig, entry, chars });
  cacheChars += chars;
  while (cacheChars > CACHE_MAX_CHARS && logCache.size > 1) {
    const oldest = logCache.keys().next().value;
    cacheChars -= logCache.get(oldest).chars;
    logCache.delete(oldest);
  }
  cacheMisses++;
}

function buildEntry(events) {
  return { transcript: transcript(events), trend: trendOf(events) };
}

/** 同步取 entry（CLI 用；命中缓存则不重复解压）。 */
function entrySync(path) {
  const sig = sigSync(path);
  const hit = cacheGet(path, sig);
  if (hit) return hit;
  const entry = buildEntry(parseEventsText(readSessionLog(path)));
  cacheSet(path, sig, entry);
  return entry;
}

/** 异步取 entry（网页端用；解压走并发异步，不阻塞事件循环）。 */
async function entryAsync(path) {
  const sig = await sigAsync(path);
  const hit = cacheGet(path, sig);
  if (hit) return hit;
  const buf = await readFile(path);
  const entry = buildEntry(parseEventsText(await readSessionLogAsync(path, buf)));
  cacheSet(path, sig, entry);
  return entry;
}

/** 缓存统计（自检用）。 */
export function cacheStats() {
  return { entries: logCache.size, chars: cacheChars, hits: cacheHits, misses: cacheMisses };
}

// ---------------------------------------------------------------------------
// 对外的同步 API（CLI）
// ---------------------------------------------------------------------------

/** 定位 + 解析 + 折叠某个会话。 */
export function transcriptOfSession(home, sessionId) {
  const path = findSessionLog(home, sessionId);
  if (!path) return null;
  return { path, ...entrySync(path).transcript };
}

/** 跨会话全文搜索（同步）。 */
export function searchAll(home, query, opts = {}) {
  return searchWith(home, query, opts, (path) => entrySync(path));
}

/** 某个会话的每步 token 用量时间序列（同步）。 */
export function trendSeries(home, sessionId) {
  const path = findSessionLog(home, sessionId);
  if (!path) return null;
  return entrySync(path).trend;
}

// ---------------------------------------------------------------------------
// 对外的异步 API（网页端）：签名与同步版一致，只是 await
// ---------------------------------------------------------------------------

export async function transcriptOfSessionAsync(home, sessionId) {
  const path = findSessionLog(home, sessionId);
  if (!path) return null;
  const entry = await entryAsync(path);
  return { path, ...entry.transcript };
}

export async function searchAllAsync(home, query, opts = {}) {
  return searchWithAsync(home, query, opts, (path) => entryAsync(path));
}

export async function trendSeriesAsync(home, sessionId) {
  const path = findSessionLog(home, sessionId);
  if (!path) return null;
  const entry = await entryAsync(path);
  return entry.trend;
}

// ---------------------------------------------------------------------------
// 搜索实现（同步/异步共用匹配逻辑，只有取 entry 的方式不同）
// ---------------------------------------------------------------------------

function matchSession(s, t, needle, includeReasoning, limit, results) {
  for (const m of t.messages) {
    if (results.length >= limit) break;
    const haystacks = [m.text];
    if (includeReasoning && m.role === "assistant" && m.reasoning) haystacks.push(m.reasoning);
    for (const text of haystacks) {
      if (!text) continue;
      const idx = text.toLowerCase().indexOf(needle);
      if (idx === -1) continue;
      const radius = 90;
      const start = Math.max(0, idx - radius);
      const end = Math.min(text.length, idx + needle.length + radius);
      results.push({
        sessionId: s.id,
        shortId: s.id.replace(/^session-/, "").slice(0, 8),
        workspace: s.wsTitle,
        title: t.title ?? s.title,
        role: m.role,
        time: m.time,
        model: m.model,
        snippet: (start > 0 ? "…" : "") + text.slice(start, end) + (end < text.length ? "…" : ""),
      });
      break;
    }
  }
}

function searchWith(home, query, { limit = 20, includeArchived = false, includeReasoning = false } = {}, getEntry) {
  const store = loadStore(home);
  const needle = query.toLowerCase();
  const results = [];
  for (const s of store.sessions) {
    if (!includeArchived && s.archived) continue;
    if (results.length >= limit) break;
    const path = findSessionLog(home, s.id);
    if (!path) continue;
    let t;
    try {
      t = getEntry(path).transcript;
    } catch {
      continue;
    }
    matchSession(s, t, needle, includeReasoning, limit, results);
  }
  return results;
}

async function searchWithAsync(home, query, { limit = 20, includeArchived = false, includeReasoning = false } = {}, getEntry) {
  const store = loadStore(home);
  const needle = query.toLowerCase();
  const results = [];
  for (const s of store.sessions) {
    if (!includeArchived && s.archived) continue;
    if (results.length >= limit) break;
    const path = findSessionLog(home, s.id);
    if (!path) continue;
    let t;
    try {
      t = (await getEntry(path)).transcript;
    } catch {
      continue;
    }
    matchSession(s, t, needle, includeReasoning, limit, results);
  }
  return results;
}
