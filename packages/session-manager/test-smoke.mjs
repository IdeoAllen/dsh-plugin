#!/usr/bin/env node
/**
 * test-smoke.mjs —— host 半区冒烟测试（不需要重启 DSH，用 mock ctx 直接跑路由）。
 *
 * 覆盖：路由注册、完整界面伺服的 API 前缀改写、overview/session/trend/search/export 五个接口。
 * 刻意**不**调用 archive（会真的改 workspace.json），只验证它对未知 id 返回 404。
 */
process.env.DSH_HOME = process.env.DSH_HOME || 'C:\\Users\\43594\\.toa3\\harness-runtime\\.dsh'

const routes = new Map()
const ctx = {
  webServer: {
    register(r) {
      routes.set(r.path, r.handler)
    },
  },
  logger: console,
}

const mod = await import(new URL('./lib/index.js', import.meta.url).href)
console.log('插件 name:', mod.name, '| inject:', (mod.inject || []).join(','))
mod.apply(ctx)

console.log('\n注册的路由（' + routes.size + ' 条）:')
for (const p of routes.keys()) console.log('  ' + p)

function makeRes() {
  const out = { code: null, headers: null, body: null }
  return {
    writeHead(code, headers) {
      out.code = code
      out.headers = headers
    },
    end(body) {
      out.body = body
    },
    out,
  }
}

/**
 * 构造请求。**必须带 socket.remoteAddress 与 Host**：所有路由都过了 loopback 围栏，
 * 少了这两项会被 403 拦掉（这正是围栏该有的行为，不是 bug）。
 */
function makeReq(path, { url, method = 'GET', remote = '127.0.0.1', host = '127.0.0.1:3082' } = {}) {
  return { url: url || path, method, socket: { remoteAddress: remote }, headers: { host } }
}

async function call(path, opts = {}) {
  const handler = routes.get(path)
  if (!handler) throw new Error('路由未注册: ' + path)
  const res = makeRes()
  await handler(makeReq(path, opts), res)
  return res.out
}

let failures = 0
function check(label, cond, extra) {
  const ok = Boolean(cond)
  if (!ok) failures++
  console.log(`  ${ok ? '✅' : '❌'} ${label}${extra ? '  ' + extra : ''}`)
}

console.log('\n===== 完整界面 /dshm =====')
const page = await call('/dshm')
const html = String(page.body || '')
check('HTTP 200 + text/html', page.code === 200 && /text\/html/.test(page.headers['content-type'] || ''))
check('页面已把 /api/ 改写成 /dshm/api/', html.includes('/dshm/api/overview') && !/["'`(]\/api\//.test(html))
check('页面含标题', /<title>/.test(html), String(html.length) + ' 字节')

console.log('\n===== /dshm/api/overview =====')
const ov = await call('/dshm/api/overview')
const overview = JSON.parse(ov.body)
check('HTTP 200', ov.code === 200)
check('会话列表非空', Array.isArray(overview.sessionList) && overview.sessionList.length > 0, overview.sessionList.length + ' 个会话 / ' + overview.workspaceList.length + ' 个工作区')
check('含 home 与 updatedAt', Boolean(overview.home && overview.updatedAt), overview.home)
check('含当前目标', Boolean(overview.goal && (overview.goal.objective || overview.goal.id)))

console.log('\n===== /dshm/api/session =====')
const bigId = overview.sessionList.slice().sort((a, b) => (b.steps || 0) - (a.steps || 0))[0].id
const one = JSON.parse((await call('/dshm/api/session', { url: '/dshm/api/session?id=' + bigId })).body)
check('拿到详情', one && one.id === bigId, '步数 ' + (one.stats?.steps ?? '?') + ' · 引用 ' + String(one.resumeUri || '').slice(0, 28) + '…')
const missing = await call('/dshm/api/session', { url: '/dshm/api/session?id=session-does-not-exist' })
check('未知 id 返回 404', missing.code === 404)

console.log('\n===== /dshm/api/trend =====')
const tr = JSON.parse((await call('/dshm/api/trend', { url: '/dshm/api/trend?id=' + bigId })).body)
check('拿到用量序列', Array.isArray(tr) && tr.length > 0, tr.length + ' 个点')

console.log('\n===== /dshm/api/search =====')
const se = JSON.parse((await call('/dshm/api/search', { url: '/dshm/api/search?q=deepseek' })).body)
check('搜索有命中', Array.isArray(se) && se.length > 0, se.length + ' 条命中 · 首条 ' + (se[0]?.shortId || ''))

console.log('\n===== /dshm/api/export =====')
const md = await call('/dshm/api/export', { url: '/dshm/api/export?id=' + bigId + '&format=md' })
check('Markdown 导出', md.code === 200 && /text\/markdown/.test(md.headers['content-type'] || ''), String(md.body.length) + ' 字节 · ' + md.headers['content-disposition'])
const js = await call('/dshm/api/export', { url: '/dshm/api/export?id=' + bigId + '&format=json' })
check('JSON 导出', js.code === 200 && /application\/json/.test(js.headers['content-type'] || ''), String(js.body.length) + ' 字节')

console.log('\n===== /dshm/api/archive（只验证不存在的 id，避免改动真实数据） =====')
const ar = await call('/dshm/api/archive', { url: '/dshm/api/archive?id=session-nope&archived=true', method: 'POST' })
check('未知 id 返回 404（未写盘）', ar.code === 404)
const arGet = await call('/dshm/api/archive', { url: '/dshm/api/archive?id=' + bigId, method: 'GET' })
check('GET 返回 405（要求 POST）', arGet.code === 405)

console.log('\n===== loopback 围栏 =====')
// 插件路由不在 DSH 外壳的鉴权门后面，必须自行校验来源。详见 lib/loopback.js。
const nonLoopbackPeer = await call('/dshm', { remote: '192.168.1.9' })
check('局域网来源被拒 403', nonLoopbackPeer.code === 403, 'code=' + nonLoopbackPeer.code)
const rebind = await call('/dshm', { host: 'evil.example.com' })
check('伪造 Host（DNS rebinding）被拒 403', rebind.code === 403, 'code=' + rebind.code)
const localhostOk = await call('/dshm', { host: 'localhost:3082' })
check('localhost Host 放行', localhostOk.code === 200, 'code=' + localhostOk.code)

console.log(failures === 0 ? '\n✅ host 半区冒烟测试全部通过' : `\n❌ 有 ${failures} 项失败`)
process.exitCode = failures === 0 ? 0 : 1
