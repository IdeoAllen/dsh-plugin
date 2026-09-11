#!/usr/bin/env node
/**
 * test-client.mjs —— 浏览器半区冒烟测试（无浏览器：mock window.__ModuleLoader__ + mock React）。
 *
 * 覆盖：bundle 加载、factory 执行、apply 注册 settings.section、组件首屏渲染分支。
 */
let bundle = null
let stored = null

globalThis.window = {
  __ModuleLoader__: {
    load(m) {
      bundle = m
    },
  },
  localStorage: {
    getItem: () => stored,
    setItem: (_k, v) => {
      stored = v
    },
  },
  navigator: { clipboard: { writeText: () => {} } },
}

// 极简 React mock：够跑组件函数体，不追求 reconciler
const React = {
  createElement(type, props) {
    return { type, props: props || {}, children: Array.prototype.slice.call(arguments, 2) }
  },
  useState(init) {
    return [typeof init === 'function' ? init() : init, function () {}]
  },
  useCallback(fn) {
    return fn
  },
  useEffect() {},
}
const requireShim = (name) => {
  if (name === 'react') return React
  throw new Error('unexpected require: ' + name)
}

let failures = 0
const check = (label, cond, extra) => {
  const ok = Boolean(cond)
  if (!ok) failures++
  console.log(`  ${ok ? '✅' : '❌'} ${label}${extra ? '  ' + extra : ''}`)
}

await import(new URL('./lib/client.js', import.meta.url).href)
console.log('===== bundle =====')
check('window.__ModuleLoader__.load 被调用', Boolean(bundle))
check('模块 id 正确', bundle && bundle.id === '@chengchengzhao/dsh-session-manager', bundle && bundle.id)

const mod = bundle.factory(requireShim)
console.log('\n===== 导出与 slot 注册 =====')
check('导出 apply / inject', typeof mod.apply === 'function' && Array.isArray(mod.inject))
check('inject 声明 slots', (mod.inject || []).includes('slots'))

const registered = []
const slots = {
  inject(name, fn) {
    fn()
  },
  register(meta, render) {
    registered.push({ meta, render })
  },
}
mod.apply({ get: (n) => (n === 'slots' ? slots : null) })
check('注册了 1 个设置页分区', registered.length === 1)
const meta = registered[0] && registered[0].meta
check('分区元数据正确', meta && meta.name === 'settings.section' && meta.id === 'session-manager' && meta.label() === '会话管理', meta && `${meta.name}/${meta.id}/order=${meta.order}/label=${meta.label()}`)

console.log('\n===== 组件首屏（无缓存 → 加载中分支） =====')
const el = registered[0].render()
check('render 返回元素', Boolean(el && el.type))
const tree = el.type(el.props)
const flat = JSON.stringify(tree)
check('首屏渲染出「加载中」', flat.includes('加载中'))
check('首屏不抛异常', tree && tree.type === 'div')

console.log(failures === 0 ? '\n✅ 客户端半区冒烟测试全部通过' : `\n❌ 有 ${failures} 项失败`)
process.exitCode = failures === 0 ? 0 : 1
