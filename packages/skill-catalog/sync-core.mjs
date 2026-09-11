#!/usr/bin/env node
/**
 * sync-core.mjs —— 把工具目录生成的看板页面同步进插件
 *
 * 插件必须**自包含**（不能依赖包外相对路径），因此把 `../技能总览.html`
 * 复制到 `lib/core/web/index.html`。host 半区再把这个文件里的
 * `./catalog.json` 改写成 `/skills/api/catalog`，从而走实时数据。
 *
 * 用法：node sync-core.mjs
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * 从插件目录向上搜索工作区里的看板产物目录（判据：含 build-html.mjs）。
 * 刻意用搜索而不是固定相对层数：插件在仓库里的位置一变，固定层数就会指错。
 * 可用 `DSH_SKILL_CATALOG_DIR` 显式覆盖。
 */
function findToolDir(start) {
  let dir = start
  for (let i = 0; i < 10; i++) {
    const cand = join(dir, '工具', 'skill-catalog')
    if (existsSync(join(cand, 'build-html.mjs'))) return cand
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }
  return null
}

const TOOL_DIR = process.env.DSH_SKILL_CATALOG_DIR || findToolDir(HERE)
const SRC = TOOL_DIR ? join(TOOL_DIR, '技能总览.html') : join(HERE, '技能总览.html')
const DEST_DIR = join(HERE, 'lib', 'core', 'web')
const DEST = join(DEST_DIR, 'index.html')

if (!existsSync(SRC)) {
  console.error(`源文件不存在：${SRC}`)
  console.error('先跑：node 工具/skill-catalog/build-html.mjs')
  console.error('（若看板工具目录不在默认位置，用 DSH_SKILL_CATALOG_DIR=<路径> 指定）')
  process.exit(1)
}

mkdirSync(DEST_DIR, { recursive: true })
const html = readFileSync(SRC, 'utf8')
writeFileSync(DEST, html, 'utf8')

const kb = (statSync(DEST).size / 1024).toFixed(0)
console.log(`已同步：${SRC} → ${DEST}  (${kb} KB)`)
console.log('host 半区会把页面里的 ./catalog.json 改写成 /skills/api/catalog（实时数据）')
