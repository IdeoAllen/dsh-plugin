#!/usr/bin/env node
/**
 * test-client.mjs —— 浏览器半区契约测试（零依赖）
 *
 * DSH 客户端插件的 bundle 格式约束很硬，违反了会**静默不挂载**（不报错、界面不出现），
 * 所以这些约束必须由测试守着：
 *   - 必须是纯 JavaScript：禁止 import / TypeScript / JSX
 *   - 必须用 window.__ModuleLoader__.load({ id, factory }) 包装
 *   - React 只能通过 factory 的 require('react') 注入
 *   - 必须导出 apply/inject，并注册到官方 slots（不要直接操作 DOM）
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const R = []
const ck = (name, ok, detail = '') => R.push({ name, ok: Boolean(ok), detail })

const src = readFileSync(join(HERE, 'lib', 'client.js'), 'utf8')

ck('语法可解析', (() => { try { new Function(src); return true } catch { return false } })())
ck('无 import 语句', !/^\s*import\s/m.test(src))
ck('无 JSX', !/<\/[A-Za-z]/.test(src))
ck('用 __ModuleLoader__.load 包装', /window\.__ModuleLoader__\.load\(\{/.test(src))
ck('id 与包名一致', /id:\s*'@chengchengzhao\/dsh-skill-catalog'/.test(src))
ck('React 由 require 注入', /var React = require\('react'\)/.test(src))
ck('用 React.createElement', /React\.createElement/.test(src))
ck('导出 apply', /exports\.apply = apply/.test(src))
ck('导出 inject 且含 slots', /exports\.inject = inject/.test(src) && /var inject = \['slots'\]/.test(src))
ck('走官方 slots 注册（非 DOM 操作）', /slots\.inject\('settings\.section'/.test(src))
ck('未直接插入 DOM 节点', !/document\.body\.appendChild|insertBefore\(/.test(src))
ck('跟随 DSH 主题变量', /--dsw-alias-label-primary/.test(src))

// 与兄弟插件保持同一套卡片数值
ck('卡片外观符合家族约定', /borderRadius: 10, padding: '9px 12px', marginBottom: 8/.test(src))
ck('次级文字 12px/INK2', /fontSize: 12, color: INK2/.test(src))

// 元数据自洽
const pkg = JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8'))
ck('package.json 有 license', Boolean(pkg.license))
ck('package.json 有 author', Boolean(pkg.author))
ck('声明 dsh.client.platform = web', pkg.dsh?.client?.platform === 'web')
ck('files 收录 lib', Array.isArray(pkg.files) && pkg.files.includes('lib'))
ck('LICENSE 文件存在', existsSync(join(HERE, 'LICENSE')))
ck('README 存在', existsSync(join(HERE, 'README.md')))

console.log('skill-catalog 浏览器半区契约测试\n')
for (const r of R) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `\n        ${r.detail}`}`)
const bad = R.filter((r) => !r.ok).length
console.log(`\n结果：${R.length - bad}/${R.length} 通过`)
process.exitCode = bad ? 1 : 0
