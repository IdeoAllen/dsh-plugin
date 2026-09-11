#!/usr/bin/env node
/**
 * test-smoke.mjs —— 宿主半区冒烟测试（零依赖，node test-smoke.mjs 即可跑）
 *
 * 覆盖：
 *   1. 目录构建器：技能数、字段完整性、无 undefined
 *   2. 路由：注册齐全、页面/接口/健康检查返回正确
 *   3. loopback 围栏：本机放行、伪造 Host 与局域网来源一律 403
 *
 * 用 mock webServer 驱动，不依赖运行中的 DSH。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const R = []
const ck = (name, ok, detail = '') => R.push({ name, ok: Boolean(ok), detail })

/* ── 1. 目录构建器 ── */
const { buildCatalog, SKILLS_ROOT } = await import(pathToFileURL(join(HERE, 'lib', 'catalog.js')).href)
const cands = [
  process.env.DSH_SKILL_REGISTRY,
  join(HERE, '..', '..', '..', 'skill-registry', 'registry.json'),
  join(HERE, '..', '..', 'skill-registry', 'registry.json'),
].filter(Boolean)
const out = buildCatalog({ registryCandidates: cands })

ck('catalog.js 可构建且无 error', !out.error, out.error || '')
ck('技能数 > 0', out.skills.length > 0, `实际 ${out.skills.length}`)
ck('统计字段齐全', ['total', 'byCategory', 'bySource', 'byLevel', 'withTriggers', 'withBoundary', 'withScripts', 'truncated'].every((k) => k in out.stats), JSON.stringify(Object.keys(out.stats)))
ck('技能对象无 undefined 字段', out.skills.every((s) => Object.values(s).every((v) => v !== undefined)))
ck('每个技能都有 name/category/purpose', out.skills.every((s) => s.name && s.category && s.purpose))
ck('triggers/models 都是数组', out.skills.every((s) => Array.isArray(s.triggers) && Array.isArray(s.models)))

/* ── 2. 路由 ── */
const mod = await import(pathToFileURL(join(HERE, 'lib', 'index.js')).href)
const routes = new Map()
mod.apply({ webServer: { register: (r) => routes.set(r.path, r.handler) } })
ck('注册 /skills 页面', routes.has('/skills'))
ck('注册 /skills/api/catalog', routes.has('/skills/api/catalog'))
ck('注册 /skills/api/skill', routes.has('/skills/api/skill'))
ck('注册 /skills/api/health', routes.has('/skills/api/health'))

const mkres = () => ({ code: null, headers: null, body: null, writeHead(c, h) { this.code = c; this.headers = h }, end(p) { this.body = p } })
const req = (remote, host) => ({ url: '/x', socket: { remoteAddress: remote }, headers: { host } })
const OK = req('127.0.0.1', '127.0.0.1:3082')

const page = mkres()
await routes.get('/skills')(OK, page)
ck('页面返回 200 且是 HTML', page.code === 200 && /text\/html/.test(page.headers?.['content-type'] || ''))
ck('页面已改写 API 前缀', page.body.includes('/skills/api/catalog') && !page.body.includes("fetch('./catalog.json'"))

const catalog = mkres()
await routes.get('/skills/api/catalog')(OK, catalog)
ck('catalog 返回 200', catalog.code === 200)
const j = JSON.parse(catalog.body)
ck('catalog 技能数与构建器一致', j.skills.length === out.skills.length)

const health = mkres()
await routes.get('/skills/api/health')(OK, health)
ck('health.ok = true', JSON.parse(health.body).ok === true)

/* ── 3. loopback 围栏 ── */
const rb = mkres()
await routes.get('/skills/api/catalog')(req('127.0.0.1', 'evil.example.com'), rb)
ck('伪造 Host（DNS rebinding）被拒 403', rb.code === 403, `code=${rb.code}`)

const lan = mkres()
await routes.get('/skills/api/catalog')(req('192.168.1.9', '127.0.0.1:3082'), lan)
ck('局域网来源被拒 403', lan.code === 403, `code=${lan.code}`)

/* ── 4. 界面文件已同步 ── */
const html = readFileSync(join(HERE, 'lib', 'core', 'web', 'index.html'), 'utf8')
ck('看板页面已同步（>100KB）', html.length > 100000, `${html.length} 字符`)
ck('看板页面自带图标（无 favicon 404）', /rel="icon" href="data:image\/svg\+xml/.test(html))

console.log('skill-catalog 宿主半区冒烟测试\n')
for (const r of R) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `\n        ${r.detail}`}`)
const bad = R.filter((r) => !r.ok).length
console.log(`\n结果：${R.length - bad}/${R.length} 通过`)
process.exitCode = bad ? 1 : 0
