#!/usr/bin/env node
/**
 * verify-html.mjs —— 对「技能总览.html」做**不依赖浏览器**的静态校验
 *
 * 校验项：
 *   1. 内联的 DATA JSON 能解析，且技能数与 catalog.json 一致
 *   2. 页面 JS 语法可解析（用 new Function 只解析不执行）
 *   3. 关键 DOM 节点 id 齐全（表格/搜索/筛选/弹窗）
 *   4. 无外部网络依赖（不应出现 http(s) 资源引用）
 *   5. 抽查数据字段完整性（用途/触发词/模型/验证级别）
 *
 * 用法：node 工具/skill-catalog/verify-html.mjs
 */

import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * 产物目录解析，与 build-html.mjs 同一套规则：
 * 环境变量 → 向上搜 catalog.json / 技能总览.html → 回退脚本自身目录。
 * 独立仓库里没有 catalog.json，此时跳过「与 catalog.json 对账」那一项（其余检查照跑）。
 */
function resolveDataDir() {
  const env = process.env.DSH_SKILL_CATALOG_DIR
  if (env && existsSync(join(env, '技能总览.html'))) return env
  let dir = HERE
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, '技能总览.html'))) return dir
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }
  return HERE
}

const DATA_DIR = resolveDataDir()
const HTML = join(DATA_DIR, '技能总览.html')
const CATALOG = join(DATA_DIR, 'catalog.json')

const results = []
const check = (name, pass, detail = '') => results.push({ name, pass: Boolean(pass), detail })

if (!existsSync(HTML)) {
  console.error('未找到 技能总览.html，先跑：node tools/build-html.mjs')
  process.exit(1)
}
const html = readFileSync(HTML, 'utf8')
// 没有 catalog.json 时用 null 标记，后续对账项自动降级为跳过
const catalog = existsSync(CATALOG) ? JSON.parse(readFileSync(CATALOG, 'utf8')) : null

/* 1. 内联快照数据 */
let data = null
const m = html.match(/const SNAPSHOT = (\{[\s\S]*?\});\nlet S = SNAPSHOT\.skills/)
try { data = JSON.parse(m ? m[1] : 'null') } catch (e) { /* 下面统一报错 */ }
check('1a 内联快照可解析', Boolean(data), m ? '未匹配到 SNAPSHOT 定义' : '未找到 SNAPSHOT 定义')
if (data) {
  if (catalog) {
    check('1b 技能数与 catalog.json 一致', data.skills.length === catalog.skills.length,
      `html=${data.skills?.length} catalog=${catalog.skills.length}`)
  }
  check('1c 技能条数 > 0', data.skills.length > 0, `实际 ${data.skills.length}`)
}

/* 2. 页面脚本语法 */
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((x) => x[1])
check('2a 存在 1 个内联脚本', scripts.length === 1, `实际 ${scripts.length} 个`)
if (scripts.length) {
  let syntaxOk = true, err = ''
  try { new Function(scripts[0]) } catch (e) { syntaxOk = false; err = e.message }
  check('2b 页面 JS 语法可解析', syntaxOk, err)
}

/* 3. 关键 DOM 节点 */
const ids = ['q', 'fcat', 'fsrc', 'flev', 'sort', 'tb', 'empty', 'stats', 'gen', 'dlg', 'd-name', 'd-meta', 'd-body']
const missing = ids.filter((id) => !new RegExp(`id="${id}"`).test(html))
check('3 关键 DOM 节点齐全', missing.length === 0, `缺：${missing.join(', ')}`)

/* 4. 无外部依赖 */
const externals = [...html.matchAll(/(?:src|href)="(https?:)?\/\/[^"]+"/g)].map((x) => x[0])
check('4 无外部网络资源（可离线打开）', externals.length === 0, externals.slice(0, 3).join(' | '))
check('4b 无 favicon 404（已内联 data URI）', /rel="icon" href="data:image\/svg\+xml/.test(html))

/* 4c. 动态能力：应优先实时读取 catalog.json，失败才回退内联快照 */
check('4c 页面会实时读取 ./catalog.json', /fetch\('\.\/catalog\.json/.test(html))
check('4d 提供手动刷新按钮', /id="reload"/.test(html))
check('4e 实时/快照状态可见', /SOURCE==='live'/.test(html) && /内联快照/.test(html))
check('4f fetch 失败时静默回退（不阻塞渲染）', /catch\s*\(e\)\s*\{[\s\S]{0,200}SOURCE = 'snapshot'/.test(html))

/* 4g. 滚动条层级：全页只允许「关弹窗时 body 滚 / 开弹窗时 .db 滚」，不得嵌套 */
check('4g 弹窗打开时锁住页面滚动', /body:has\(dialog\[open\]\)\{overflow:hidden\}/.test(html))
check('4h dialog 自身不滚动（只让 .db 滚）', /dialog\{[^}]*overflow:hidden/.test(html))
check('4i 正文预览不再单独开滚动区', !/pre\.preview\{[^}]*overflow:auto/.test(html))
const scrollers = (html.match(/overflow:\s*auto/g) || []).length
check('4j 滚动容器总数 ≤ 3（页面/弹窗体/表格）', scrollers <= 3, `实际 ${scrollers} 处 overflow:auto`)

/* 4k. 页面家族约定：页头结构与设计令牌必须与 dshm / cost-manager 同构 */
check('4k 页头用 brand + span 副标题', /class="brand">[^<]*<span>/.test(html))
check('4l 页头有 .toolbar', /class="toolbar"/.test(html))
check('4m 有「打开 Web GUI」回链（有来有回）', /打开 Web GUI/.test(html))
check('4n 有兄弟页交叉链接', /href="\/cost"/.test(html) && /href="\/dshm"/.test(html))
check('4o 有自动刷新开关', /id="autoRefresh"/.test(html) && /setAutoRefresh/.test(html))
check('4p 令牌名与家族一致', ['--panel2', '--border', '--text', '--muted', '--radius'].every((t) => html.includes(t + ':')))
check('4q 无旧令牌名残留', !/var\(--(line|fg|dim|accent2|warn|bad|ok)\)/.test(html))
check('4r 用系统字体族（非等宽）', /-apple-system/.test(html) && !/font:14px\/1\.6 ui-monospace/.test(html))
check('4s 统计卡用 .cards/.card 语法', /class="cards"/.test(html))
check('4t 内容区 max-width:1180px 居中', /max-width:\s*1180px/.test(html))

/* 5. 字段完整性抽查 */
if (data) {
  const s = data.skills
  check('5a 每个技能都有用途描述', s.every((x) => x.purpose && x.purpose.length > 0),
    `缺失 ${s.filter((x) => !x.purpose).length} 个`)
  check('5b 每个技能都有分类', s.every((x) => x.category),
    `缺失 ${s.filter((x) => !x.category).length} 个`)
  check('5c 触发词已解析为数组', s.every((x) => Array.isArray(x.triggers)))
  check('5d 关联模型已解析为数组', s.every((x) => Array.isArray(x.models)))
  check('5e 验证级别齐全', s.every((x) => x.level),
    `缺失 ${s.filter((x) => !x.level).length} 个`)
  const withTrg = s.filter((x) => x.triggers.length).length
  const withBnd = s.filter((x) => x.boundary).length
  const withMdl = s.filter((x) => x.models.length).length
  check('5f 统计口径合理', withTrg > 0 && withBnd > 0, `触发词 ${withTrg} / 边界 ${withBnd} / 模型 ${withMdl}`)
  // 触发词不应残留引号或斜杠
  const dirty = s.flatMap((x) => x.triggers).filter((t) => /^["'“”‘’\/]|["'“”‘’]$/.test(t))
  check('5g 触发词已清洗（无引号/斜杠残留）', dirty.length === 0, dirty.slice(0, 5).join(', '))
  // 不应再出现使用次数字段
  check('5h 已移除使用次数统计', !/\.uses\b|modelsUsed|totalCalls|usedSkills/.test(html),
    'HTML 中仍含使用次数字段')
}

console.log('技能总览.html —— 静态校验\n')
for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `\n        ${r.detail}`}`)
const failed = results.filter((r) => !r.pass).length
console.log(`\n结果：${results.length - failed}/${results.length} 通过`)
console.log(`文件：${HTML}`)
process.exitCode = failed ? 1 : 0
