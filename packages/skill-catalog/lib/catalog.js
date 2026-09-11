/**
 * 技能目录构建器（host 半区，自包含）
 *
 * 数据来源（全部本地只读）：
 *   1. ~/.agents/skills/<dir>/SKILL.md   —— name / description / 正文（始终可用，实时）
 *   2. <workspace>/工具/skill-registry/registry.json —— 验证级别/来源/证据（可选，缺失则降级）
 *
 * 设计约束（沿用 dshm / cost-manager 的教训）：
 *   - 自包含：不依赖包外相对路径，只用 node 内置模块
 *   - 实时：每次请求现算，不依赖构建产物，避免陈旧
 *   - 容错：注册表缺失/损坏时仍能返回技能清单，只是少了验证字段
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

/** 技能库唯一真源（DSH 只扫描这里）。 */
export const SKILLS_ROOT = join(homedir(), '.agents', 'skills')

/** 目录注入上限：@deepseek-ai/dsh-tool-skill 的 catalogDescriptionMaxLength 默认 500。 */
export const CATALOG_DESCRIPTION_MAX = 500
export const CATALOG_VISIBLE_LIMIT = CATALOG_DESCRIPTION_MAX - 3

const CATEGORIES = {
  内容创作: ['zimeiti-content','wechat-publish','wechat-mp-auto','original-writing','ai-polish','humanizer','content-rewrite','content-repurposing','content-scraper','content-calendar','hook-angle-lab','social-media-strategy','brand-voice-system','ad-copywriting','research-to-article','advanced-xhs-visual-design','xiaohongshu-auto','notes-research'],
  视频与音频: ['short-video-script','short-video-script-lab','seedance-video','videocut-jiankoubo','embedded-captions','talking-head-recut','digital-human','video-transcribe','video-account-analysis','music-to-video','motion-graphics','general-video','faceless-explainer','product-launch-video','slideshow','hyperframes','hyperframes-core','hyperframes-cli','hyperframes-animation','hyperframes-audio','hyperframes-creative','hyperframes-keyframes','hyperframes-registry','media-use'],
  图像: ['image-generation','prompt-engineering'],
  知识与思考: ['second-brain','obsidian','book-distillation','learning-loop','knowledge-palace','memory-boost','insight','best-minds','yizhou-thinking'],
  代理与工程: ['active-agent','proactive-agent','multi-agent-orchestrator','context-engineering-agent','repo-context-compiler','agent-eval-loop','code-review-ci','coding-agent','mcp-builder','api-gateway','browser-automation','browser-research-agent','workflow-automation-builder','self-improvement','quality-code','frontend-verify'],
  技能治理: ['skill-creator','skill-finder','skill-vetter','skill-discovery','skill-distillation'],
  商业与财务: ['business-analysis','business-writing','market-research-analyst','business-dashboard-analyst','finance-assistant','asset-allocation-risk-review','financial-risk-literacy','lead-followup-automation','spreadsheet-analyst','project-management','work-report'],
  办公与效率: ['office-docs','docx-report-builder','editable-pptx-builder','ppt-outline','dashi-ppt','yizhou-ppt','professional-email','meeting-notes','meeting-notes-actions','scheduling','file-organization','invoice-processing','sonoscli','cost-control','cost-manager','model-routing'],
}
const NAME_TO_CAT = {}
for (const [cat, names] of Object.entries(CATEGORIES)) for (const n of names) NAME_TO_CAT[n] = cat

const MODEL_LEXICON = [
  ['deepseek-v4-pro', /\bdeepseek-v4-pro\b|v4-pro/i, '复杂推理 / 深度分析'],
  ['deepseek-v4-flash', /\bdeepseek-v4-flash\b|v4-flash\b/i, '日常 / 批量 / 省钱档'],
  ['v4-flash-vision', /flash-vision|vision-exp/i, '读图 / 图文理解'],
  ['Kimi', /moonshot|kimi|月之暗面/i, '中文写作 / 长文档'],
  ['GLM', /zai-coding|\bglm-\d|\bGLM\b/i, '纯编程 / 技术方案'],
  ['Seedream', /seedream|即梦/i, '文生图（火山方舟）'],
  ['Seedance', /seedance/i, '文生视频（火山方舟）'],
  ['nano-banana', /nano-banana/i, '文生图（MXAPI）'],
  ['gpt-image', /gpt-image/i, '文生图（含画面文字）'],
  ['doubao', /豆包|doubao/i, '火山豆包'],
  ['edge-tts', /edge-tts/i, '本机免费配音'],
  ['whisper', /whisper/i, '本机语音转写'],
  ['ffmpeg', /ffmpeg/i, '本机视频处理'],
]

function cleanToken(t) {
  return t.replace(/^[\s"'“”‘’/、,，]+|[\s"'“”‘’]+$/g, '').trim()
}

/** description → { purpose, triggers[], boundary } */
export function parseDescription(desc) {
  const parts = String(desc || '').split('｜')
  const main = (parts[0] || '').trim()
  const boundary = parts.slice(1).join('｜').trim()
  const m =
    main.match(/触发词[如:：]\s*([^。；;]+)/) ||
    main.match(/触发(?:场景|条件)[:：]\s*([^。；;]+)/) ||
    main.match(/(?:Trigger(?:s)? on|Use when|Use for|Triggers? when)\s*[:：]?\s*([^.]{4,})/i)
  let triggers = []
  if (m) {
    const raw = m[1].trim()
    if (/[\u4e00-\u9fa5]/.test(raw)) {
      triggers = raw.split(/[\/、,，]/).map(cleanToken).filter((t) => t.length >= 2 && t.length <= 30)
    } else {
      const one = cleanToken(raw).replace(/\s+/g, ' ')
      triggers = one ? [one.length > 90 ? one.slice(0, 90) + '…' : one] : []
    }
  }
  let purpose = main
    .replace(/触发词[如:：][^。；;]*[。；;]?/g, '')
    .replace(/触发(?:场景|条件)[:：][^。；;]*[。；;]?/g, '')
    .replace(/(?:Trigger(?:s)? on|Use when|Use for|Triggers? when)\s*[:：]?\s*[^.]*\.?/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!purpose) purpose = main
  return { purpose, triggers, boundary }
}

/** SKILL.md → { frontmatter 键值, body }（容忍 BOM 与 > / | 块标量） */
function splitFrontmatter(raw) {
  const text = String(raw).replace(/^\uFEFF/, '')
  const m = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/)
  const fm = m ? m[1] : ''
  const body = m ? text.slice(m[0].length) : text
  const scalar = (key) => {
    const block = fm.match(new RegExp(`^${key}:\\s*[>|][-+]?\\s*\\r?\\n((?:[ \\t]+.*\\r?\\n?)+)`, 'm'))
    if (block) return block[1].split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join(' ')
    const single = fm.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))
    if (single) {
      const v = single[1].trim()
      return /^[>|][-+]?$/.test(v) ? '' : v
    }
    return ''
  }
  return { scalar, body }
}

function summarizeBody(body) {
  const lines = body.split(/\r?\n/)
  const headings = []
  let lead = ''
  for (const l of lines) {
    const hm = l.match(/^(#{1,3})\s+(.+)$/)
    if (hm) { if (headings.length < 40) headings.push({ level: hm[1].length, text: hm[2].trim() }); continue }
    if (!lead && l.trim() && !l.startsWith('---') && !l.startsWith('|')) lead = l.trim()
  }
  const textOnly = lines.filter((l) => !/^#{1,6}\s/.test(l)).join('\n').replace(/\n{3,}/g, '\n\n').trim()
  return { headings, lead, preview: textOnly.slice(0, 2600), previewTruncated: textOnly.length > 2600 }
}

/** 尝试加载注册表（用于补充验证级别/来源/证据）。找不到就返回空，不报错。 */
export function loadRegistry(candidates = []) {
  for (const p of candidates) {
    try {
      if (!p || !existsSync(p)) continue
      const j = JSON.parse(readFileSync(p, 'utf8'))
      if (j && typeof j.skills === 'object') return { path: p, skills: j.skills, lastScanAt: j.lastScanAt }
    } catch {
      /* 损坏就跳过 */
    }
  }
  return { path: null, skills: {}, lastScanAt: null }
}

/** 构建完整目录。 */
export function buildCatalog({ registryCandidates = [] } = {}) {
  const reg = loadRegistry(registryCandidates)
  const skills = []
  let dirs = []
  try {
    dirs = readdirSync(SKILLS_ROOT, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
  } catch {
    return { error: `技能库不可读：${SKILLS_ROOT}`, skills: [], stats: null }
  }

  for (const dir of dirs) {
    const file = join(SKILLS_ROOT, dir, 'SKILL.md')
    if (!existsSync(file)) continue
    let raw
    try { raw = readFileSync(file, 'utf8') } catch { continue }
    const { scalar, body } = splitFrontmatter(raw)
    const name = scalar('name') || dir
    const description = scalar('description')
    const parsed = parseDescription(description)
    const { headings, lead, preview, previewTruncated } = summarizeBody(body)
    const entry = reg.skills[name] || {}
    const models = MODEL_LEXICON.filter(([, re]) => re.test(body) || re.test(description)).map(([n, , scene]) => ({ name: n, scene }))
    let mtime = null
    try { mtime = statSync(file).mtimeMs } catch { /* 忽略 */ }

    skills.push({
      name,
      dir,
      category: NAME_TO_CAT[name] || '其它',
      purpose: parsed.purpose,
      triggers: parsed.triggers,
      boundary: parsed.boundary,
      description,
      lead,
      headings,
      preview,
      previewTruncated,
      bodyLength: body.trim().length,
      source: entry.source || '未登记',
      license: entry.license || '',
      commercialUse: entry.commercialUse || '',
      redistribute: entry.redistribute || '',
      level: entry.level || 'unregistered',
      evidence: entry.evidence || '',
      note: entry.note || '',
      version: entry.version || '',
      // 与 build-catalog.mjs 的输出保持同字段：看板页面直接读这些指标，
      // 少一个就会在详情里显示 undefined（插件版曾漏了 steps/codeBlocks/hasScripts）。
      steps: entry.metrics?.steps ?? 0,
      codeBlocks: entry.metrics?.codeBlocks ?? 0,
      hasScripts: Boolean(entry.metrics?.hasScriptsDir),
      missingBins: entry.metrics?.missingBins || [],
      truncated: description.length > CATALOG_DESCRIPTION_MAX,
      boundaryOffset: description.indexOf('｜'),
      mtime,
      models,
    })
  }

  skills.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name))
  const stats = {
    total: skills.length,
    byCategory: Object.fromEntries([...new Set(skills.map((s) => s.category))].map((c) => [c, skills.filter((s) => s.category === c).length])),
    bySource: {
      自建: skills.filter((s) => s.source === '本机自建').length,
      上游: skills.filter((s) => s.source !== '本机自建' && s.source !== '未登记').length,
      未登记: skills.filter((s) => s.source === '未登记').length,
    },
    byLevel: Object.fromEntries([...new Set(skills.map((s) => s.level))].map((l) => [l, skills.filter((s) => s.level === l).length])),
    withTriggers: skills.filter((s) => s.triggers.length).length,
    withBoundary: skills.filter((s) => s.boundary).length,
    withScripts: skills.filter((s) => s.hasScripts).length,
    truncated: skills.filter((s) => s.truncated).length,
    boundaryAtRisk: skills.filter((s) => s.boundaryOffset >= 0 && s.description.length > CATALOG_VISIBLE_LIMIT).length,
    registryPath: reg.path,
    registryLastScanAt: reg.lastScanAt,
    skillsRoot: SKILLS_ROOT,
    generatedAt: new Date().toISOString(),
  }
  return { stats, skills }
}
