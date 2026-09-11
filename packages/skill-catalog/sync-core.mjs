#!/usr/bin/env node
/**
 * sync-core.mjs —— 把渲染器产出的看板页面同步进插件
 *
 * 插件必须**自包含**（不能依赖包外相对路径），因此把 `技能总览.html`
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
 * 找 `技能总览.html` 的所在目录。三条路径按序尝试：
 *
 *   1. `DSH_SKILL_CATALOG_DIR` —— 显式指定（开发工作区用它指向 工具/skill-catalog）
 *   2. 包内 `tools/`        —— 独立仓库场景：渲染器就在那儿，产物也落在那儿
 *   3. 向上搜 `工具/skill-catalog` —— 兼容旧的工作区布局
 *
 * 用搜索而不是固定相对层数：插件在仓库里的位置一变，固定层数就会指错。
 */
function findHtmlDir() {
  const env = process.env.DSH_SKILL_CATALOG_DIR
  if (env && existsSync(join(env, '技能总览.html'))) return env

  const local = join(HERE, 'tools')
  if (existsSync(join(local, '技能总览.html'))) return local

  let dir = HERE
  for (let i = 0; i < 10; i++) {
    const cand = join(dir, '工具', 'skill-catalog')
    if (existsSync(join(cand, '技能总览.html'))) return cand
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }
  return null
}

const HTML_DIR = findHtmlDir()
const SRC = HTML_DIR ? join(HTML_DIR, '技能总览.html') : join(HERE, 'tools', '技能总览.html')
const DEST_DIR = join(HERE, 'lib', 'core', 'web')
const DEST = join(DEST_DIR, 'index.html')

if (!existsSync(SRC)) {
  console.error(`源文件不存在：${SRC}`)
  console.error('先跑：node tools/build-html.mjs')
  console.error('（若产物不在默认位置，用 DSH_SKILL_CATALOG_DIR=<路径> 指定）')
  process.exit(1)
}

mkdirSync(DEST_DIR, { recursive: true })
const html = readFileSync(SRC, 'utf8')
writeFileSync(DEST, html, 'utf8')

const kb = (statSync(DEST).size / 1024).toFixed(0)
console.log(`已同步：${SRC} → ${DEST}  (${kb} KB)`)
console.log('host 半区会把页面里的 ./catalog.json 改写成 /skills/api/catalog（实时数据）')
