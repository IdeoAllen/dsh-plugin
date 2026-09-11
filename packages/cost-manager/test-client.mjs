// cost-manager 客户端半区冒烟测试
// 验证：window.__ModuleLoader__.load 被调用 → factory 返回 apply/inject →
//       apply 在 settings.section 注册面板 → 组件能渲染出预期内容。
// 优先用 profile 里的真实 React 渲染；拿不到则用最小 mock。
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import vm from 'node:vm'

const here = new URL('.', import.meta.url)
const code = readFileSync(new URL('./lib/client.js', here), 'utf8')

// 1) 执行 client.js，捕获 __ModuleLoader__.load 的入参
let spec = null
const sandbox = {
  window: { __ModuleLoader__: { load: (s) => { spec = s } } },
  console,
  setTimeout,
  clearTimeout,
}
vm.createContext(sandbox)
vm.runInContext(code, sandbox, { filename: 'client.js' })

if (!spec) {
  console.error('❌ client.js 未调用 window.__ModuleLoader__.load')
  process.exit(1)
}
console.log('模块 id:', spec.id)
if (spec.id !== '@dachengge/dsh-cost-manager') {
  console.error('❌ 模块 id 不匹配，实际:', spec.id)
  process.exitCode = 1
}

// 2) 准备 React（真实优先）
const mockReact = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  useState: (init) => [init, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
}
let react = mockReact
let reactLabel = 'mock React'
let renderToStaticMarkup = null
try {
  const profilePkg = join(process.env.USERPROFILE || '', '.toa3', 'harness-runtime', '.dsh', 'profiles', 'web', 'package.json')
  const profileRequire = createRequire(profilePkg)
  const real = profileRequire('react')
  if (real && typeof real.createElement === 'function') {
    react = real
    reactLabel = '真实 React ' + real.version
  }
  const rds = profileRequire('react-dom/server')
  if (rds && typeof rds.renderToStaticMarkup === 'function') {
    renderToStaticMarkup = rds.renderToStaticMarkup
    reactLabel += ' + react-dom/server'
  }
} catch (e) {
  /* 回退 mock */
}
console.log('渲染器:', reactLabel)

// 3) 执行 factory
const fakeRequire = (name) => {
  if (name === 'react') return react
  throw new Error('未预期的模块请求: ' + name)
}
let mod
try {
  mod = spec.factory(fakeRequire)
} catch (e) {
  console.error('❌ factory 执行失败:', e.message)
  process.exit(1)
}
console.log('导出键:', Object.keys(mod).join(', '))
console.log('inject:', JSON.stringify(mod.inject))
if (typeof mod.apply !== 'function') {
  console.error('❌ 未导出 apply 函数')
  process.exitCode = 1
}

// 4) 用 mock ctx 调 apply，捕获 slot 注册
const captured = []
const slots = {
  inject: (slot, fn) => {
    const reg = fn()
    captured.push({ slot, reg })
  },
  register: (meta, comp) => ({ meta, comp }),
}
const ctx = { get: (name) => (name === 'slots' ? slots : undefined) }
mod.apply(ctx)

console.log('\n注册的 slot:')
for (const c of captured) {
  const label = typeof c.reg.meta.label === 'function' ? c.reg.meta.label() : '—'
  console.log(`  ${c.slot} → id=${c.reg.meta.id} order=${c.reg.meta.order} label=${label}`)
}
const target = captured.find((c) => c.slot === 'settings.section')
if (!target) {
  console.error('❌ 未注册 settings.section')
  process.exitCode = 1
}

// 4b) 侧栏入口：应注册 sidebar.footer.action，且渲染出一个指向 /board 的链接
const sideEntry = captured.find((c) => c.slot === 'sidebar.footer.action')
if (!sideEntry) {
  console.error('❌ 未注册 sidebar.footer.action（侧栏运维看板入口）')
  process.exitCode = 1
} else {
  try {
    const el = sideEntry.reg.comp()
    const flat = JSON.stringify(el)
    const ok = el && el.type === 'a' && el.props && el.props.href === '/board'
    console.log('\n[侧栏] 渲染结果:', ok ? '✅ <a href="/board">' : '❌ 不是指向 /board 的链接')
    if (!ok) {
      console.error('   实际:', flat.slice(0, 160))
      process.exitCode = 1
    }
    if (!flat.includes('运维看板')) {
      console.error('❌ 侧栏入口文案缺「运维看板」')
      process.exitCode = 1
    }
  } catch (e) {
    console.error('❌ 侧栏入口渲染失败:', e.message)
    process.exitCode = 1
  }
}

// 5) 渲染面板（初始为加载中状态）
// 5a) 真实 React + SSR（环境可用时最有说服力）
if (target && target.reg.comp && renderToStaticMarkup) {
  try {
    // DSH 契约：register 第二个参数是「返回 element 的渲染函数」
    const text = String(renderToStaticMarkup(target.reg.comp()))
    console.log('\n[SSR] 输出长度:', text.length, '| 含标题:', text.includes('费用与余额'), '| 含加载中:', text.includes('加载中'))
    console.log('[SSR] 片段:', text.replace(/\s+/g, ' ').slice(0, 180))
    if (!text.includes('费用与余额')) {
      console.error('❌ SSR 结果里没有面板标题')
      process.exitCode = 1
    }
  } catch (e) {
    console.log('\n[SSR] 环境不可用（' + String(e.message).slice(0, 70) + '）→ 回退 mock React 验证组件逻辑')
  }
}

// 5b) mock React 手动执行组件逻辑（不依赖环境，任何机器都能跑）
if (target && target.reg.comp) {
  try {
    const mod2 = spec.factory((n) => {
      if (n === 'react') return mockReact
      throw new Error('未预期模块: ' + n)
    })
    const cap2 = []
    const slots2 = { inject: (s, fn) => cap2.push({ slot: s, reg: fn() }), register: (m, c) => ({ meta: m, comp: c }) }
    mod2.apply({ get: (n) => (n === 'slots' ? slots2 : undefined) })
    const reg2 = cap2.find((c) => c.slot === 'settings.section')
    const outer = reg2.reg.comp() // { type: Panel }
    const panel = outer.type() // 手动调用 Panel（走 mock hooks）
    const flat = JSON.stringify(panel)
    console.log('\n[mock] Panel 首层 type:', panel.type, '| 初始态含「加载中」:', flat.includes('加载中'))
    if (!flat.includes('加载中')) {
      console.error('❌ 组件初始态未渲染出加载中分支')
      process.exitCode = 1
    } else {
      console.log('[mock] ✅ 组件逻辑验证通过')
    }
  } catch (e) {
    console.error('❌ 组件逻辑执行失败:', e.message)
    process.exitCode = 1
  }
}

console.log('\n' + (process.exitCode ? '存在失败项' : '✅ 客户端半区冒烟测试全部通过'))
