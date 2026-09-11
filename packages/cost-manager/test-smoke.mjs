// cost-manager 插件冒烟测试：用 mock ctx 验证
//   1) apply() 注册 4 个工具
//   2) 注册 UI 数据路由（webServer）
//   3) 工具能执行、能读绑定模型
//   4) UI 路由 handler 返回结构正确（模拟浏览器半区 fetch）
import { apply, name, inject } from './lib/index.js'

const registered = []
const routes = []
const ctx = {
  tools: { register: (t) => registered.push(t) },
  llm: {
    listProviders: () => [{ id: 'deepseek-official' }, { id: 'moonshotai-cn' }, { id: 'zai-coding-cn' }],
    listModels: (pid) =>
      ({
        'deepseek-official': [
          { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
          { id: 'deepseek-v4-flash-vision-exp', name: 'DeepSeek-V4-Flash-Vision-Exp' },
        ],
        'moonshotai-cn': [{ id: 'kimi-k2.6', name: 'Kimi K2.6' }],
        'zai-coding-cn': [{ id: 'glm-5.2', name: 'GLM-5.2' }],
      })[pid] || [],
  },
  webServer: { register: (r) => routes.push(r) },
}

apply(ctx)

console.log('插件 name:', name, '| inject:', inject.join(','))
console.log('注册工具数:', registered.length, '→', registered.map((t) => t.name).join(', '))
if (registered.length !== 4) {
  console.error('❌ 应注册 4 个工具，实际', registered.length)
  process.exit(1)
}

console.log('注册 UI 路由数:', routes.length, '→', routes.map((r) => r.path).join(', '))
// 期望：数据路由 + 实时总览页（/cost）+ 运维看板（/board，两个页签嵌 /cost 与 /dshm）
const expectedRoutes = ['/dsh-cost/api/overview', '/cost', '/cost/', '/board', '/board/']
const missingRoutes = expectedRoutes.filter((p) => !routes.some((r) => r.path === p))
if (missingRoutes.length > 0) {
  console.error('❌ UI 路由未按预期注册，缺少:', missingRoutes.join(', '))
  process.exitCode = 1
}

// 模拟浏览器半区 fetch 该路由：mock req/res，捕获写出的 JSON
const route = routes.find((r) => r.path === '/dsh-cost/api/overview')
let captured = null
const fakeRes = {
  writeHead: () => {},
  end: (body) => {
    captured = JSON.parse(body)
  },
}
/**
 * 构造请求。**必须带 socket.remoteAddress 与 Host**：所有路由都过了 loopback 围栏，
 * 少了这两项会被 403 拦掉（这正是围栏该有的行为，不是 bug）。
 */
function makeReq(path, { url, method = 'GET', remote = '127.0.0.1', host = '127.0.0.1:3082' } = {}) {
  return { url: url || path, method, socket: { remoteAddress: remote }, headers: { host } }
}

await route.handler(makeReq('/dsh-cost/api/overview'), fakeRes)
console.log('\n===== UI 路由 /dsh-cost/api/overview =====')
if (!captured || captured.ok !== true) {
  console.error('❌ 路由未返回 ok:true')
  process.exitCode = 1
} else {
  console.log('余额平台数:', captured.balances?.length)
  console.log('硬地板:', JSON.stringify(captured.floors))
  console.log('消耗速率平台数:', captured.burn?.byPlatform?.length, '· 窗口', captured.burn?.windowHours + 'h')
  for (const b of captured.burn?.byPlatform || []) {
    const row = captured.balances.find((x) => x.platform === b.platform)
    const floor = captured.floors[b.platform]
    const balNum = row ? parseFloat(String(row.balance || '').match(/¥([\d.]+)/)?.[1]) : NaN
    const tail = Number.isFinite(balNum) && floor !== undefined && b.ratePerHour > 0
      ? ` → 可撑 ${(((balNum - floor) / b.ratePerHour)).toFixed(1)} 小时`
      : ''
    console.log(`  ${b.platform}: ¥${b.ratePerHour.toFixed(2)}/h${tail}`)
  }
  console.log('LLM 用量:', captured.usage?.msgs, '条 · ¥' + (captured.usage?.cost || 0).toFixed(2), '·', ((captured.usage?.tokens || 0) / 1e6).toFixed(2) + 'M token')
  console.log('账 B 实付:', captured.ledger?.count, '笔 · ¥' + (captured.ledger?.total || 0).toFixed(3), '· 待补', captured.ledger?.pending, '笔')
  console.log('账 B 文件:', captured.ledger?.path || '（未找到）')
  if (captured.ledger?.path) {
    for (const p of captured.ledger.byPlatform || []) console.log(`  ${p.platform}: ¥${p.cost.toFixed(3)}（${p.count} 笔）`)
  }
}

console.log('\n===== 页面路由：/cost 与 /board =====')
async function callRoute(path, req = {}) {
  const r = routes.find((x) => x.path === path)
  let body = null
  let headers = null
  let status = null
  const res = {
    writeHead: (c, h) => {
      status = c
      headers = h
    },
    end: (b) => {
      body = b
    },
  }
  await r.handler(makeReq(path, req), res)
  return { body: String(body || ''), headers, status }
}

const costPage = await callRoute('/cost')
console.log('  /cost :', costPage.body.length, '字节 · 含页头 brand:', costPage.body.includes('class="brand"'), '· dshm 同款令牌:', costPage.body.includes('--panel: #161a22'))
if (!costPage.body.includes('--panel: #161a22')) {
  console.error('  ❌ /cost 未使用 dshm 同款设计令牌')
  process.exitCode = 1
}

const board = await callRoute('/board')
const boardHtml = board.body
const headerCount = (boardHtml.match(/<header[\s>]/g) || []).length
console.log('  /board:', boardHtml.length, '字节 · <header> 数量:', headerCount, '· 页签数:', (boardHtml.match(/class="tab[ "]/g) || []).length, '· iframe 数:', (boardHtml.match(/<iframe/g) || []).length)
// 关键回归：看板自己不能再有页头，否则与 iframe 内页面的页头重复
if (headerCount !== 0) {
  console.error('  ❌ /board 自己渲染了页头，会与嵌入页面的页头重复')
  process.exitCode = 1
}
if (!boardHtml.includes('tabstrip') || !boardHtml.includes('src="/cost"') || !boardHtml.includes('src="/dshm"')) {
  console.error('  ❌ /board 缺少页签栏或 iframe')
  process.exitCode = 1
}
if (boardHtml.includes('class="brand"')) {
  console.error('  ❌ /board 仍带 brand 标题（重复头）')
  process.exitCode = 1
}

/* loopback 围栏：插件路由不在 DSH 外壳的鉴权门后面，必须自行校验来源。详见 lib/loopback.js */
console.log('\n===== loopback 围栏 =====')
const fenceCases = [
  ['/cost', { remote: '192.168.1.9' }, 403, '局域网来源'],
  ['/cost', { host: 'evil.example.com' }, 403, '伪造 Host（DNS rebinding）'],
  ['/cost', { host: 'localhost:3082' }, 200, 'localhost 放行'],
  ['/board', { host: 'evil.example.com' }, 403, '/board 同样受保护'],
]
for (const [path, opts, expect, label] of fenceCases) {
  const r = await callRoute(path, opts)
  const got = r.status
  const ok = got === expect
  console.log(`  ${ok ? '✅' : '❌'} ${label}  code=${got}（期望 ${expect}）`)
  if (!ok) process.exitCode = 1
}

for (const t of registered) {
  console.log('\n===== ' + t.name + ' =====')
  try {
    const out = await t.execute(t.name === 'cost_stats' ? { group: 'model' } : t.name === 'cost_report' ? { days: 30 } : {})
    console.log(String(out).slice(0, 700))
  } catch (e) {
    console.log('❌ ERR', e.message)
    process.exitCode = 1
  }
}
