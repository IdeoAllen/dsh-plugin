/**
 * DSH 技能总览插件 —— host 半区
 *
 * 用同一个 DSH 端口提供技能目录界面，与 dshm / cost-manager 两个看板同一风格、同一入口族。
 *
 * 注册的路由：
 *   GET /skills                    完整「技能总览」界面（单页）
 *   GET /skills/api/catalog        实时技能目录（JSON，每次请求现算）
 *   GET /skills/api/skill?name=    单个技能详情（含正文预览）
 *   GET /skills/api/health         自检
 *
 * 设计约束（沿用 dshm / cost-manager 的教训）：
 *   - 数据实时：直接扫 ~/.agents/skills，不依赖构建产物，天然不会陈旧
 *   - 注册表可选：找得到就用它补验证级别，找不到也能正常出界面
 *   - 延迟加载：核心模块动态 import，单模块出问题不拖垮 DSH 启动
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { checkLoopback } from './loopback.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const CORE = join(HERE, 'core')

export const name = 'dsh-skill-catalog'
export const inject = ['webServer']

async function core() {
  return import(pathToFileURL(join(HERE, 'catalog.js')).href)
}

/**
 * 注册表候选路径：插件是 link 安装，import.meta.url 会解析回源码目录，
 * 因此相对路径可用；再补上环境变量与常见工作区路径兜底。
 */
function registryCandidates() {
  return [
    process.env.DSH_SKILL_REGISTRY,
    join(HERE, '..', '..', '..', 'skill-registry', 'registry.json'), // 工具/skill-catalog/dsh-plugin → 工具/skill-registry
    join(HERE, '..', '..', 'skill-registry', 'registry.json'),
    'C:/Users/43594/Desktop/harness中心/工具/skill-registry/registry.json',
  ].filter(Boolean)
}

function send(res, code, body, contentType = 'application/json; charset=utf-8', extraHeaders = null) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body)
  res.writeHead(code, {
    'content-type': contentType,
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    ...(extraHeaders || {}),
  })
  res.end(payload)
}

/** 完整界面 HTML：把页面里的 ./catalog.json 改写成插件路由（页面文件本身不动）。 */
function renderPage() {
  const file = join(CORE, 'web', 'index.html')
  if (!existsSync(file)) throw new Error(`技能总览界面缺失：${file}（先跑 node sync-core.mjs）`)
  // 刻意不缓存：页面只有 ~500KB，本地单用户场景读一次可忽略，
  // 换来的是**改完 HTML 跑一次 sync-core.mjs 就能刷新看到，无需重启 DSH**。
  return readFileSync(file, 'utf8').split('./catalog.json').join('/skills/api/catalog')
}

export function apply(ctx) {
  if (typeof ctx.webServer?.register !== 'function') {
    console.error('[dsh-skill-catalog] webServer 服务不可用，UI 路由未注册')
    return
  }

  const route = (path, handler) => {
    try {
      ctx.webServer.register({ kind: 'exact', path, handler })
    } catch (error) {
      console.error(`[dsh-skill-catalog] 路由注册失败 ${path}：${error?.message || error}`)
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

  for (const path of ['/skills', '/skills/']) {
    route(path, wrap(async (_req, res) => {
      send(res, 200, renderPage(), 'text/html; charset=utf-8')
    }))
  }

  route('/skills/api/catalog', wrap(async () => {
    const { buildCatalog } = await core()
    return buildCatalog({ registryCandidates: registryCandidates() })
  }))

  route('/skills/api/skill', wrap(async (req, res) => {
    const { buildCatalog } = await core()
    const wanted = q(req, 'name')
    const { skills } = buildCatalog({ registryCandidates: registryCandidates() })
    const hit = skills.find((s) => s.name === wanted)
    if (!hit) {
      send(res, 404, { error: `未找到技能：${wanted}` })
      return undefined
    }
    return hit
  }))

  route('/skills/api/health', wrap(async () => {
    const { buildCatalog, SKILLS_ROOT } = await core()
    const out = buildCatalog({ registryCandidates: registryCandidates() })
    return {
      ok: !out.error,
      plugin: 'dsh-skill-catalog',
      skillsRoot: SKILLS_ROOT,
      skillCount: out.skills?.length ?? 0,
      registry: out.stats?.registryPath || null,
      pageReady: existsSync(join(CORE, 'web', 'index.html')),
      error: out.error || null,
    }
  }))

  console.log('[dsh-skill-catalog] 已注册：/skills 与 /skills/api/*')
}
