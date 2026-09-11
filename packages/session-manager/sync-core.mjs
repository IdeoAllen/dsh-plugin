#!/usr/bin/env node
/**
 * sync-core.mjs —— 把 dshm 的核心源同步进插件包（lib/core），保证单一事实来源。
 *
 * 用法：node 工具/dshm-plugin/sync-core.mjs
 *   ../../dshm/lib/{home,store,format,logs,commands}.js → lib/core/
 *   ../../dshm/lib/web/index.html                      → lib/core/web/index.html
 *
 * 说明：
 *   - 这五个模块彼此只用相对路径 + Node 内置模块，内联后自包含。
 *   - 网页 index.html 里的 `/api/xxx` 由 host 半区在伺服时改写成 `/dshm/api/xxx`，
 *     所以这里原样复制，不做改写（保持与 dshm CLI 侧一致）。
 *   - 不允许把用户数据带进包：dshm 的 export/backup 产物都在包外，脚本会主动剔除。
 */
import { copyFileSync, mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN = dirname(fileURLToPath(import.meta.url))

/**
 * 从插件目录向上搜索工作区根（同时含 `工具/` 与 `dshm/` 的那一层）。
 * 刻意用搜索而不是固定 `../..` 层数：插件在仓库里的位置一变，
 * 固定层数就会悄悄指错目录。可用 `DSH_WORKSPACE` 显式覆盖。
 */
function findWorkspace(start) {
  let dir = start
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, '工具')) && existsSync(join(dir, 'dshm'))) return dir
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }
  return null
}

const WORKSPACE = process.env.DSH_WORKSPACE || findWorkspace(PLUGIN)
if (!WORKSPACE) {
  console.error('找不到工作区根（应同时含 工具/ 与 dshm/）。可用 DSH_WORKSPACE=<路径> 指定。')
  process.exit(1)
}
const SRC = join(WORKSPACE, 'dshm', 'lib')
const CORE = join(PLUGIN, 'lib', 'core')
const WEB = join(CORE, 'web')
mkdirSync(WEB, { recursive: true })

const manifest = [
  [join(SRC, 'home.js'), join(CORE, 'home.js')],
  [join(SRC, 'store.js'), join(CORE, 'store.js')],
  [join(SRC, 'format.js'), join(CORE, 'format.js')],
  [join(SRC, 'logs.js'), join(CORE, 'logs.js')],
  [join(SRC, 'commands.js'), join(CORE, 'commands.js')],
  [join(SRC, 'web', 'index.html'), join(WEB, 'index.html')],
]

let n = 0
for (const [src, dst] of manifest) {
  if (!existsSync(src)) {
    console.error(`✗ 源文件不存在：${src}`)
    process.exitCode = 1
    continue
  }
  const buf = readFileSync(src)
  copyFileSync(src, dst)
  n++
  console.log(`✓ ${src.split(/[\\/]/).pop()} → ${dst.replace(PLUGIN, 'dshm-plugin')} (${(buf.length / 1024).toFixed(1)} KB)`)
}

// 用户数据 / 导出产物绝不允许进包
for (const name of ['export', 'backup', 'usage.jsonl']) {
  const p = join(CORE, name)
  if (existsSync(p)) {
    rmSync(p, { recursive: true, force: true })
    console.log(`🧹 已剔除用户数据：core/${name}`)
  }
}

console.log(`\n同步完成：${n} 个核心文件已内联进插件包。`)
