/**
 * DSH 会话管理插件（dshm）— host 半区
 *
 * 目标：把原本独立的 dshm 网页（独立进程 + 8787 端口）统一到 DSH 自身端口上，
 * 并在设置页提供一个「会话管理」面板，与 DSH GUI 融为一个界面。
 *
 * 设计约束（沿用 cost-manager 踩过的坑）：
 *   - 核心逻辑内联在 lib/core/（由 sync-core.mjs 从 ../../dshm/lib 同步），自包含、无包外相对路径依赖。
 *   - 核心模块用动态 import 延迟加载：单个模块出问题不会拖垮 DSH 启动。
 *   - 只读为主；唯一的写操作是 archive/unarchive（改 $DSH_HOME/storages/workspace.json）。
 *   - 会话日志读取走 logs.js 的异步 + 缓存路径（7 万+ zstd 帧，同步版会阻塞 host 事件循环）。
 *
 * 注册的路由（都挂在 DSH 自己的端口上）：
 *   GET  /dshm                     完整 dshm 界面（原 8787 那份单页）
 *   GET  /dshm/api/overview        概览 + 会话表 + 工作区表
 *   GET  /dshm/api/session?id=     单个会话详情
 *   GET  /dshm/api/search?q=       跨会话全文搜索
 *   GET  /dshm/api/trend?id=       每步 token 用量序列
 *   GET  /dshm/api/export?id=&format=md|json   导出可读记录
 *   POST /dshm/api/archive?id=&archived=true|false
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { checkLoopback } from './loopback.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const CORE = join(HERE, 'core')

export const name = 'dsh-session-manager'
export const inject = ['webServer']

/** 待伺服的完整界面 HTML（首次请求时读取 + 改写 API 前缀，之后复用）。 */
let pageCache = null

/** 动态加载内联核心模块（任一模块出问题只影响对应路由）。 */
async function core() {
  const [homeMod, storeMod, commandsMod, logsMod] = await Promise.all([
    import(pathToFileURL(join(CORE, 'home.js')).href),
    import(pathToFileURL(join(CORE, 'store.js')).href),
    import(pathToFileURL(join(CORE, 'commands.js')).href),
    import(pathToFileURL(join(CORE, 'logs.js')).href),
  ])
  return { homeMod, storeMod, commandsMod, logsMod }
}

/**
 * 解析 DSH 主目录：优先运行中的 DSH_HOME（插件跑在 host 进程内，这个值就是当前实例），
 * 其次回落到 dshm 自己的自动发现逻辑（--home/env/.toa3/~/.dsh/WorkBuddy）。
 */
async function resolveTargetHome() {
  if (process.env.DSH_HOME) return process.env.DSH_HOME
  const { homeMod } = await core()
  return homeMod.resolveHome().home
}

function send(res, code, body, contentType = 'application/json; charset=utf-8', extraHeaders = null) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body)
  const headers = {
    'content-type': contentType,
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    ...(extraHeaders || {}),
  }
  res.writeHead(code, headers)
  res.end(payload)
}

function shortId(id) {
  return id ? String(id).replace(/^session-/, '').slice(0, 8) : ''
}

/** 完整界面 HTML：把页面里的 /api/xxx 改写成 /dshm/api/xxx（页面本身不动）。 */
function renderPage() {
  if (pageCache) return pageCache
  const file = join(CORE, 'web', 'index.html')
  if (!existsSync(file)) throw new Error(`dshm 界面文件缺失：${file}（先跑 node sync-core.mjs）`)
  const html = readFileSync(file, 'utf8').split('/api/').join('/dshm/api/')
  pageCache = html
  return html
}

/** 概览：与 dshm 自己那份 server.js 的 overview() 保持同形，页面无需改动。 */
async function overview() {
  const home = await resolveTargetHome()
  const { storeMod, commandsMod } = await core()
  const store = storeMod.loadStore(home)
  const snap = commandsMod.statusSnapshot(store)
  const sessions = store.sessions.map((s) => ({
    id: s.id,
    shortId: shortId(s.id),
    title: s.title,
    workspace: s.wsTitle,
    cwd: s.cwd,
    turns: s.turns,
    steps: s.steps,
    inputTokens: s.inputTokens,
    outputTokens: s.outputTokens,
    cacheReadTokens: s.cacheReadTokens,
    contextPct: s.contextPct,
    contextUsed: s.contextUsed,
    contextWindow: s.contextWindow,
    archived: s.archived,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    goal: commandsMod.goalInfo(s.goal),
  }))
  const workspaces = store.workspaces.map((w) => ({
    id: w.id,
    title: w.title,
    path: w.path,
    sessions: (w.sessionIds || []).length,
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
  }))
  return {
    ...snap,
    home,
    updatedAt: new Date().toISOString(),
    activeSessions: sessions.filter((s) => !s.archived).length,
    archivedSessions: sessions.filter((s) => s.archived).length,
    sessionList: sessions,
    workspaceList: workspaces,
  }
}

async function detail(id) {
  const home = await resolveTargetHome()
  const { storeMod, commandsMod } = await core()
  const store = storeMod.loadStore(home)
  const r = commandsMod.resolveSession(store, id)
  if (!r) return null
  if (r.ambiguous) return { ambiguous: r.ambiguous.map((s) => s.id) }
  const s = r
  return {
    id: s.id,
    shortId: shortId(s.id),
    title: s.title,
    workspace: s.wsTitle,
    cwd: s.cwd,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    archived: s.archived,
    stats: s.stats,
    tokenUsage: s.tokenUsage,
    contextPressure: s.contextPressure,
    contextBreakdown: s.contextBreakdown,
    permissions: s.permissions,
    goal: commandsMod.goalInfo(s.goal),
    todos: s.todos,
    plan: s.plan,
    resumeUri: commandsMod.sessionUri(s.id),
    webUrl: commandsMod.WEB_URL(),
  }
}

async function exportOne(id, format) {
  const home = await resolveTargetHome()
  const { storeMod, commandsMod, logsMod } = await core()
  const store = storeMod.loadStore(home)
  const r = commandsMod.resolveSession(store, id)
  if (!r || r.ambiguous) return null
  const t = await logsMod.transcriptOfSessionAsync(home, r.id)
  if (!t) return null
  if (format === 'json') {
    return {
      body:
        JSON.stringify(
          { sessionId: r.id, title: t.title ?? r.title, workspace: r.wsTitle, cwd: r.cwd, header: t.header, messages: t.messages },
          null,
          2,
        ) + '\n',
      type: 'application/json; charset=utf-8',
      filename: r.id + '.json',
    }
  }
  return {
    body: commandsMod.renderMarkdown(r, t),
    type: 'text/markdown; charset=utf-8',
    filename: r.id + '.md',
  }
}

async function archive(id, archived) {
  const home = await resolveTargetHome()
  const { storeMod, commandsMod } = await core()
  const store = storeMod.loadStore(home)
  const r = commandsMod.resolveSession(store, id)
  if (!r || r.ambiguous) return null
  storeMod.setSessionArchived(home, r.id, archived)
  return { ok: true, id: r.id, archived }
}

export function apply(ctx) {
  if (typeof ctx.webServer?.register !== 'function') {
    console.error('[dsh-session-manager] webServer 服务不可用，UI 路由未注册')
    return
  }

  const route = (path, handler) => {
    try {
      ctx.webServer.register({ kind: 'exact', path, handler })
    } catch (error) {
      console.error(`[dsh-session-manager] 路由注册失败 ${path}：${error?.message || error}`)
    }
  }

  const q = (req, key) => {
    try {
      return new URL(req.url || '/', 'http://localhost').searchParams.get(key)
    } catch {
      return null
    }
  }

  const wrap = (fn) => async (req, res) => {
    // loopback 围栏：插件路由不在 DSH 外壳的鉴权门后面，必须自行校验来源。
    // 详见 lib/loopback.js 的说明（DNS rebinding / 局域网暴露）。
    const guard = checkLoopback(req)
    if (!guard.ok) {
      send(res, 403, { error: 'forbidden: loopback-only', detail: guard.reason })
      return
    }
    try {
      const out = await fn(req, res)
      if (out !== undefined) send(res, 200, out)
    } catch (error) {
      send(res, 500, { ok: false, error: String(error?.message || error) })
    }
  }

  // 完整界面（原 dshm 8787 那份单页），挂在 DSH 自己的端口下
  for (const path of ['/dshm', '/dshm/']) {
    route(
      path,
      wrap(async (_req, res) => {
        send(res, 200, renderPage(), 'text/html; charset=utf-8')
      }),
    )
  }

  route('/dshm/api/overview', wrap(async () => overview()))

  route(
    '/dshm/api/session',
    wrap(async (req, res) => {
      const d = await detail(q(req, 'id'))
      if (!d) {
        send(res, 404, { error: 'session not found' })
        return undefined
      }
      return d
    }),
  )

  route(
    '/dshm/api/search',
    wrap(async (req) => {
      const home = await resolveTargetHome()
      const { logsMod } = await core()
      return await logsMod.searchAllAsync(home, q(req, 'q') || '', {
        limit: 50,
        includeArchived: q(req, 'all') === 'true',
        includeReasoning: q(req, 'reasoning') === 'true',
      })
    }),
  )

  route(
    '/dshm/api/trend',
    wrap(async (req, res) => {
      const home = await resolveTargetHome()
      const { storeMod, commandsMod, logsMod } = await core()
      const r = commandsMod.resolveSession(storeMod.loadStore(home), q(req, 'id'))
      if (!r || r.ambiguous) {
        send(res, 404, { error: 'session not found' })
        return undefined
      }
      return (await logsMod.trendSeriesAsync(home, r.id)) ?? []
    }),
  )

  route(
    '/dshm/api/export',
    wrap(async (req, res) => {
      const out = await exportOne(q(req, 'id'), q(req, 'format') || 'md')
      if (!out) {
        send(res, 404, { error: 'no log' })
        return undefined
      }
      send(res, 200, out.body, out.type, { 'content-disposition': `attachment; filename="${out.filename}"` })
      return undefined
    }),
  )

  route(
    '/dshm/api/archive',
    wrap(async (req, res) => {
      if (req.method !== 'POST') {
        send(res, 405, { error: 'use POST' })
        return undefined
      }
      const out = await archive(q(req, 'id'), q(req, 'archived') === 'true')
      if (!out) {
        send(res, 404, { error: 'session not found or ambiguous' })
        return undefined
      }
      return out
    }),
  )
}
