#!/usr/bin/env node
/**
 * sync-core.mjs —— 把 CLI 侧的核心源同步进插件包（lib/core），保证单一事实来源。
 *
 * 用法：node dsh-plugin/sync-core.mjs
 *   cost-check/balances.mjs       → dsh-plugin/lib/core/balances.mjs
 *   cost-manager/sessions.mjs     → dsh-plugin/lib/core/sessions.mjs
 *   cost-manager/pricing.mjs      → dsh-plugin/lib/core/pricing.mjs
 *   cost-manager/catalog.json     → dsh-plugin/lib/core/data/catalog.json
 *
 * 安全：包内绝不允许出现用户数据与本地运行时配置
 *   （ledger.jsonl = 真实记账明细；config.json = 本机阈值设置）。
 *   二者在运行时由代码自动创建/回退默认值，因此不进包，脚本会主动剔除。
 *
 * 发布到市场前必须跑一次，让包自包含且不含隐私数据。
 */
import { copyFileSync, mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN = dirname(fileURLToPath(import.meta.url))

/**
 * 从插件目录向上搜索工作区里的 `工具/` 目录（判据：同时含 cost-check/ 与 cost-manager/）。
 * 刻意用搜索而不是固定 `../..` 层数：插件在仓库里的位置一变，
 * 固定层数就会悄悄指错目录。可用 `DSH_TOOLS` 显式覆盖。
 */
function findTools(start) {
  let dir = start
  for (let i = 0; i < 10; i++) {
    const tools = join(dir, '工具')
    if (existsSync(join(tools, 'cost-check')) && existsSync(join(tools, 'cost-manager'))) return tools
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }
  return null
}

const TOOLS = process.env.DSH_TOOLS || findTools(PLUGIN)
if (!TOOLS) {
  console.error('找不到 工具/ 目录（应含 cost-check/ 与 cost-manager/）。可用 DSH_TOOLS=<路径> 指定。')
  process.exit(1)
}
const CORE = join(PLUGIN, 'lib', 'core')
const DATA = join(CORE, 'data')
mkdirSync(DATA, { recursive: true })

const manifest = [
  [join(TOOLS, 'cost-check', 'balances.mjs'), join(CORE, 'balances.mjs')],
  [join(TOOLS, 'cost-manager', 'sessions.mjs'), join(CORE, 'sessions.mjs')],
  [join(TOOLS, 'cost-manager', 'pricing.mjs'), join(CORE, 'pricing.mjs')],
  [join(TOOLS, 'cost-manager', 'catalog.json'), join(DATA, 'catalog.json')],
]

// 用户数据 / 本机运行时配置：不进包（首次运行由代码自动创建）
const forbidden = ['ledger.jsonl', 'config.json']

let n = 0
for (const [src, dst] of manifest) {
  const buf = readFileSync(src)
  copyFileSync(src, dst)
  n++
  console.log(`✓ ${src.split('\\').pop()} → ${dst.replace(PLUGIN, 'dsh-plugin')} (${(buf.length / 1024).toFixed(1)} KB)`)
}

for (const name of forbidden) {
  const p = join(DATA, name)
  if (existsSync(p)) {
    rmSync(p)
    console.log(`🧹 已剔除用户数据/本地配置：data/${name}（运行时自动创建）`)
  }
}

console.log(`\n同步完成：${n} 个核心文件已内联进插件包，用户数据已排除。`)
