#!/usr/bin/env node
/**
 * build-html.mjs —— 把 catalog.json 渲染成自包含的「技能总览」UI
 *
 * 产出：工具/skill-catalog/技能总览.html
 *   数据内联、无外部依赖、无网络请求 —— 双击即可打开。
 *   不展示使用次数（按用户要求）。
 *
 * 用法：node 工具/skill-catalog/build-html.mjs
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * 数据来源解析 —— 这个渲染器要能在两种环境下跑：
 *
 *   1) 开发工作区：设了 `DSH_SKILL_CATALOG_DIR`，或从脚本目录向上能搜到 `catalog.json`。
 *      那份 catalog.json 由 skill-registry 的 build-catalog.mjs 生成（含验证级别等字段）。
 *   2) 独立仓库 / npm 包：搜不到 catalog.json 时，**回退到插件自身的 `lib/catalog.js` 现算**。
 *      它扫 `~/.agents/skills` + 注册表；两者都不存在也能跑通，只是数据少一些。
 *
 * 这样仓库不需要额外的数据文件就能重建页面 —— 渲染器与数据源解耦。
 */
function resolveDataDir() {
  const env = process.env.DSH_SKILL_CATALOG_DIR
  if (env && existsSync(join(env, 'catalog.json'))) return env
  let dir = HERE
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'catalog.json'))) return dir
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }
  return null
}

const DATA_DIR = resolveDataDir()
let data
let DATA_SOURCE
if (DATA_DIR) {
  data = JSON.parse(readFileSync(join(DATA_DIR, 'catalog.json'), 'utf8'))
  DATA_SOURCE = join(DATA_DIR, 'catalog.json')
} else {
  const { buildCatalog } = await import(pathToFileURL(join(HERE, '..', 'lib', 'catalog.js')).href)
  data = buildCatalog({})
  DATA_SOURCE = 'lib/catalog.js（现场扫描，无预生成数据）'
}
const OUT = join(DATA_DIR || HERE, '技能总览.html')
const esc = (s) => String(s).replace(/<\/script>/gi, '<\\/script>')

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>技能总览 · DSH</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%230f1115'/%3E%3Ctext x='16' y='22' font-size='17' text-anchor='middle' fill='%235b8cff' font-family='monospace'%3E%E2%97%86%3C/text%3E%3C/svg%3E">
<style>
:root{
  /* 与 dshm / cost-manager 看板共用同一套设计令牌。
     变量**名**也必须一致（--border/--text/--muted/--panel2/--radius…），
     否则三份页面之间没法互相复制样式，只能各写各的。 */
  --bg:#0f1115; --panel:#161a22; --panel2:#1c212c; --border:#2a3140;
  --text:#e6e9ef; --muted:#8b93a5;
  --accent:#5b8cff; --green:#3ecf8e; --yellow:#f5c542; --red:#f26d6d;
  --radius:10px;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);
  font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",Roboto,sans-serif}
/* 页头：与 dshm / cost-manager 完全同构 —— brand(含 span 副标题) + toolbar */
header{display:flex;align-items:center;justify-content:space-between;
  padding:14px 22px;border-bottom:1px solid var(--border);
  background:var(--panel);position:sticky;top:0;z-index:10}
.brand{font-size:17px;font-weight:700}
.brand span{color:var(--muted);font-weight:400;font-size:13px;margin-left:8px}
.toolbar{display:flex;align-items:center;gap:16px}
.toolbar a{color:var(--accent);text-decoration:none}
button{background:var(--accent);color:#fff;border:0;border-radius:7px;
  padding:6px 14px;cursor:pointer;font-size:13px}
button.ghost{background:var(--panel2);color:var(--text);border:1px solid var(--border)}
button:disabled{opacity:.55;cursor:default}
label.inline{color:var(--muted);font-size:13px;display:inline-flex;align-items:center;gap:6px;cursor:pointer}
main{max-width:1180px;margin:0 auto;padding:20px 22px 60px}
/* 统计卡：与另两页同款 .cards/.card 语法 */
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:16px}
.card{background:var(--panel);border:1px solid var(--border);border-radius:var(--radius);padding:14px 16px}
.card .k{color:var(--muted);font-size:12px}
.card .v{font-size:24px;font-weight:700;margin-top:4px}
.filters{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:14px}
input[type=search],select{background:var(--panel);border:1px solid var(--border);color:var(--text);
  border-radius:7px;padding:6px 10px;font:inherit;font-size:13px;outline:none}
input[type=search]{min-width:260px;flex:1}
input[type=search]:focus,select:focus{border-color:var(--accent)}
.panel{background:var(--panel);border:1px solid var(--border);border-radius:var(--radius);padding:14px 16px}
table{width:100%;border-collapse:collapse;font-size:13px}
thead th{text-align:left;color:var(--muted);font-weight:600;padding:8px 10px;
  border-bottom:1px solid var(--border);cursor:pointer;user-select:none;white-space:nowrap}
thead th:hover{color:var(--accent)}
tbody tr{border-bottom:1px solid var(--border);cursor:pointer}
tbody tr:last-child{border-bottom:0}
tbody tr:hover{background:var(--panel2)}
td{padding:9px 10px;vertical-align:top}
.name{color:var(--accent);font-weight:600;white-space:nowrap}
.cat{color:var(--muted);white-space:nowrap;font-size:12px}
.purpose{max-width:520px}
.trg{display:flex;flex-wrap:wrap;gap:4px;max-width:300px}
.chip{background:var(--panel2);border:1px solid var(--border);color:var(--muted);border-radius:5px;
  padding:0 5px;font-size:11px;white-space:nowrap;display:inline-block;margin-right:4px;margin-bottom:3px}
.chip.m{color:var(--accent)}
.chip.n{color:var(--yellow);border-color:#4a3f22}
.lv{font-size:11px;border-radius:4px;padding:1px 6px;white-space:nowrap}
.lv.V2{background:#122a1f;color:var(--green);border:1px solid #1f5c37}
.lv.V0{background:#2a2418;color:var(--yellow);border:1px solid #4a3f22}
.up{color:var(--muted);font-size:11px}
dialog{border:1px solid var(--border);background:var(--panel);color:var(--text);border-radius:var(--radius);
  max-width:900px;width:93vw;max-height:88vh;padding:0;
  /* dialog 默认 overflow:auto（会多出一条滚动条）；只让 .db 滚 */
  overflow:hidden;display:none;flex-direction:column}
dialog[open]{display:flex}
dialog::backdrop{background:#000c}
.dh{padding:16px 20px;border-bottom:1px solid var(--border);background:var(--panel);z-index:2}
.dh h2{margin:0 0 6px;font-size:17px;color:var(--accent);padding-right:70px}
.dh .meta{color:var(--muted);font-size:12px;display:flex;gap:10px;flex-wrap:wrap}
.db{padding:16px 20px 28px;overflow:auto;flex:1;min-height:0}
.sec{margin:0 0 18px}
.sec h3{margin:0 0 6px;font-size:12px;color:var(--accent);letter-spacing:1px}
.sec p{margin:0 0 6px}
.muted{color:var(--muted)}
.toc{margin:0;padding-left:18px;color:var(--muted)}
.toc li{margin:2px 0}
.toc li.l1{color:var(--text)}
pre.preview{margin:8px 0 0;padding:10px 12px;background:var(--panel2);border:1px solid var(--border);
  border-radius:7px;color:var(--text);font-size:12px;line-height:1.55;white-space:pre-wrap}
/* 弹窗打开时锁住页面滚动：否则会出现「页面 + 弹窗体 + 正文预览」三层滚动条 */
body:has(dialog[open]){overflow:hidden}
.close{position:absolute;right:12px;top:12px;background:none;border:1px solid var(--border);
  color:var(--muted);border-radius:7px;padding:3px 9px;cursor:pointer;font:inherit}
.close:hover{color:var(--red);border-color:var(--red)}
.empty{padding:40px;text-align:center;color:var(--muted)}
footer{max-width:1180px;margin:0 auto;padding:0 22px 40px;color:var(--muted);font-size:12px}
</style>
</head>
<body>
<header>
  <div class="brand">技能总览<span>（非聊天）· 对话请用原生 Web GUI</span></div>
  <div class="toolbar">
    <a href="/cost" target="_blank" rel="noopener">费用与余额 ↗</a>
    <a href="/dshm" target="_blank" rel="noopener">会话管理 ↗</a>
    <a href="/" target="_blank" rel="noopener">打开 Web GUI ↗</a>
    <label class="inline"><input type="checkbox" id="autoRefresh" checked> 自动刷新</label>
    <button class="ghost" id="reload" title="重新读取技能目录">刷新</button>
  </div>
</header>
<main>
  <div class="cards" id="stats"></div>
  <div class="filters">
    <input type="search" id="q" placeholder="搜索：名称 / 用途 / 触发词 / 分类 …">
    <select id="fcat"></select>
    <select id="fsrc"><option value="">全部来源</option><option>自建</option><option>上游</option></select>
    <select id="flev"><option value="">全部级别</option><option>V2</option><option>V0</option></select>
    <select id="sort">
      <option value="cat">按分类</option>
      <option value="name">按名称 A→Z</option>
      <option value="size">按正文长度 ↓</option>
    </select>
  </div>
  <div class="panel">
    <table>
      <thead><tr>
        <th data-s="name">技能</th><th data-s="cat">分类</th><th>干什么用</th>
        <th>触发条件</th><th>关联模型</th><th data-s="level">验证</th>
      </tr></thead>
      <tbody id="tb"></tbody>
    </table>
    <div class="empty" id="empty" style="display:none">没有匹配的技能</div>
  </div>
</main>
<footer id="gen"></footer>

<dialog id="dlg">
  <button class="close" onclick="document.getElementById('dlg').close()">关闭</button>
  <div class="dh"><h2 id="d-name"></h2><div class="meta" id="d-meta"></div></div>
  <div class="db" id="d-body"></div>
</dialog>

<script>
/* 内联快照：仅在无法联网读取 catalog.json 时（例如 file:// 直接双击打开）作为兜底 */
const SNAPSHOT = ${esc(JSON.stringify(data))};
let S = SNAPSHOT.skills, ST = SNAPSHOT.stats, SOURCE = 'snapshot';
const esc2 = (s) => String(s==null?'':s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const chips = (arr, cls) => arr.map(t=>'<span class="chip '+(cls||'')+'">'+esc2(t)+'</span>').join('');

function renderHead(){
  // 数据时间进页脚（与 dshm / cost-manager 同构：页头保持精简，只有 brand + toolbar）
  document.getElementById('gen').textContent =
    '数据时间 ' + new Date(ST.generatedAt).toLocaleString('zh-CN') +
    '　·　' + (SOURCE==='live' ? '实时数据（每次打开现读）' : '内联快照（离线兜底）') +
    '　·　' + ST.total + ' 个技能' +
    (ST.registryPath ? '　·　注册表已连接' : '　·　注册表未找到（缺验证字段）') +
    '　·　技能库 ' + (ST.skillsRoot || '~/.agents/skills') +
    '　·　数据源：registry.json + ~/.agents/skills/*/SKILL.md（本地只读，无网络请求）';
  // 统计卡用 .cards/.card 语法（与另两页同款）
  document.getElementById('stats').innerHTML =
    [['技能总数',ST.total],['自建',ST.bySource['自建']],['上游',ST.bySource['上游']],
     ['有触发词',ST.withTriggers],['有边界声明',ST.withBoundary],['含脚本',ST.withScripts],
     ['已验证 V2',ST.byLevel['V2']||0],['超长截断',ST.truncated]]
    .map(([l,v])=>'<div class="card"><div class="k">'+l+'</div><div class="v">'+(v==null?'—':v)+'</div></div>').join('');
  const keep = document.getElementById('fcat').value;
  const cats = Object.keys(ST.byCategory).sort((a,b)=>ST.byCategory[b]-ST.byCategory[a]);
  document.getElementById('fcat').innerHTML = '<option value="">全部分类（'+ST.total+'）</option>' +
    cats.map(c=>'<option value="'+c+'">'+c+'（'+ST.byCategory[c]+'）</option>').join('');
  if (keep) document.getElementById('fcat').value = keep;
}

let sortKey='cat';
const tb=document.getElementById('tb');

function rowHtml(s){
  return '<tr data-i="'+S.indexOf(s)+'">' +
    '<td class="name">'+esc2(s.name)+(s.source!=='本机自建'?' <span class="up">上游</span>':'')+'</td>' +
    '<td class="cat">'+esc2(s.category)+'</td>' +
    '<td class="purpose">'+esc2(s.purpose.slice(0,130))+(s.purpose.length>130?'…':'')+'</td>' +
    '<td><div class="trg">'+chips(s.triggers.slice(0,6))+'</div></td>' +
    '<td><div class="trg">'+chips(s.models.slice(0,3).map(m=>m.name),'m')+
      (s.missingBins.length?'<span class="chip n">缺 '+esc2(s.missingBins.join('/'))+'</span>':'')+'</div></td>' +
    '<td><span class="lv '+s.level+'">'+s.level+'</span></td>' +
  '</tr>';
}

function apply(){
  const q=document.getElementById('q').value.trim().toLowerCase();
  const fc=document.getElementById('fcat').value, fs=document.getElementById('fsrc').value, fl=document.getElementById('flev').value;
  let list=S.filter(s=>{
    if(fc&&s.category!==fc) return false;
    if(fs==='自建'&&s.source!=='本机自建') return false;
    if(fs==='上游'&&s.source==='本机自建') return false;
    if(fl&&s.level!==fl) return false;
    if(q){
      const hay=(s.name+' '+s.purpose+' '+s.triggers.join(' ')+' '+s.boundary+' '+s.category+' '+s.description+' '+s.lead).toLowerCase();
      if(!hay.includes(q)) return false;
    }
    return true;
  });
  list.sort((a,b)=> sortKey==='name'?a.name.localeCompare(b.name)
    : sortKey==='size'?b.bodyLength-a.bodyLength
    : a.category.localeCompare(b.category)||a.name.localeCompare(b.name));
  tb.innerHTML=list.map(rowHtml).join('');
  document.getElementById('empty').style.display=list.length?'none':'block';
  [...tb.querySelectorAll('tr')].forEach(tr=>tr.onclick=()=>openDetail(S[+tr.dataset.i]));
}

function openDetail(s){
  document.getElementById('d-name').textContent=s.name;
  document.getElementById('d-meta').innerHTML =
    '<span>'+esc2(s.category)+'</span><span class="lv '+s.level+'">'+s.level+'</span>'+
    '<span>来源：'+esc2(s.source)+'</span><span>许可：'+esc2(s.license||'—')+'</span>'+
    '<span>商用：'+esc2(s.commercialUse||'—')+'</span>'+
    (s.version?'<span>v'+esc2(s.version)+'</span>':'');
  const sec=(t,h)=>'<div class="sec"><h3>'+t+'</h3>'+h+'</div>';
  let h='';
  h+=sec('干什么用','<p>'+esc2(s.purpose||'（未提供描述）')+'</p>');
  h+=sec('触发条件', s.triggers.length
    ? '<div class="trg">'+chips(s.triggers)+'</div>'
    : '<p class="muted">未写触发词。<b>这不影响自动调用</b> —— DSH 没有触发词机制，'+
      '它把每个技能的 name + description 注入上下文，由模型按<b>语义</b>判断是否加载。'+
      '触发词只是作者写在描述里的示例。<br>'+
      '实证：本机调用过的技能里，有 1/3 从未写触发词（含调用次数最多的 archify）。</p>');
  if(s.boundary) h+=sec('什么时候不该用','<p class="muted">'+esc2(s.boundary)+'</p>');
  if(s.lead) h+=sec('怎么用 · 开篇', '<p class="muted">'+esc2(s.lead.slice(0,400))+'</p>');
  if(s.headings.length) h+=sec('怎么用 · 正文骨架',
    '<ol class="toc">'+s.headings.map(x=>'<li class="l'+(x.level<=1?1:2)+'">'+esc2(x.text)+'</li>').join('')+'</ol>');
  if(s.preview) h+=sec('怎么用 · 正文预览',
    '<pre class="preview">'+esc2(s.preview)+'</pre>'+
    (s.previewTruncated?'<p class="muted" style="margin-top:6px">（已截断，完整内容见 SKILL.md）</p>':''));
  h+=sec('关联模型', s.models.length
    ? '<div class="trg">'+s.models.map(m=>'<span class="chip m" title="'+esc2(m.scene)+'">'+esc2(m.name)+'</span>').join('')+'</div>'+
      '<p class="muted" style="margin-top:6px">依据：技能正文提及（非使用统计）</p>'
    : '<p class="muted">正文未提及特定模型</p>');
  const facts=['正文 '+s.bodyLength.toLocaleString()+' 字符','步骤 '+s.steps,'代码块 '+s.codeBlocks,
    s.hasScripts?'含 scripts/':'无脚本'];
  if(s.missingBins.length) facts.push('缺依赖：'+s.missingBins.join('、'));
  h+=sec('指标','<p class="muted">'+esc2(facts.join('　·　'))+'</p>');
  if(s.evidence) h+=sec('验证证据','<p class="muted">'+esc2(s.evidence)+'</p>');
  if(s.note) h+=sec('备注','<p class="muted">'+esc2(s.note)+'</p>');
  h+=sec('文件位置','<p class="muted">~/.agents/skills/'+esc2(s.dir)+'/SKILL.md</p>');
  document.getElementById('d-body').innerHTML=h;
  document.getElementById('dlg').showModal();
}

document.getElementById('q').oninput=apply;
['fcat','fsrc','flev'].forEach(id=>document.getElementById(id).onchange=apply);
document.getElementById('sort').onchange=(e)=>{sortKey=e.target.value;apply();};
[...document.querySelectorAll('thead th[data-s]')].forEach(th=>th.onclick=()=>{
  const k=th.dataset.s;
  sortKey=(k==='name'||k==='size')?k:(sortKey==='cat'?'name':'cat');
  document.getElementById('sort').value=sortKey;
  apply();
});

/* ── 启动：先用内联快照秒开，再尝试拉取最新的 catalog.json 覆盖 ──
   被 DSH 以 http 方式提供时（文件预览面板）可实时刷新；
   以 file:// 直接双击打开时 fetch 会被 CORS 拦下，自动退回内联快照。 */
renderHead();
apply();

async function refresh(fromButton){
  const btn = document.getElementById('reload');
  if (btn) { btn.textContent = '读取中…'; btn.disabled = true; }
  try {
    const r = await fetch('./catalog.json?t=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    if (!j || !Array.isArray(j.skills) || !j.skills.length) throw new Error('数据为空');
    S = j.skills; ST = j.stats; SOURCE = 'live';
    renderHead(); apply();
  } catch (e) {
    SOURCE = 'snapshot';
    renderHead();
    if (fromButton) alert('无法读取技能目录，改用内联快照。\\n原因：' + e.message +
      '\\n\\n提示：以 file:// 直接打开时浏览器会拦截本地 fetch，属正常回退。');
  } finally {
    if (btn) { btn.textContent = '刷新'; btn.disabled = false; }
  }
}

/* 自动刷新：与另两页同一约定（页头一个 checkbox 控制）。
   技能目录变化不频繁，30 秒足够；只重取数据并重绘，不整页 reload。 */
let autoTimer = null;
function setAutoRefresh(on){
  if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
  if (on) autoTimer = setInterval(() => refresh(false), 30000);
}
refresh(false);
document.getElementById('reload').onclick = () => refresh(true);
const autoBox = document.getElementById('autoRefresh');
autoBox.onchange = (e) => setAutoRefresh(e.target.checked);
setAutoRefresh(autoBox.checked);
</script>
</body>
</html>`

writeFileSync(OUT, html)
console.log(`已生成 UI：${OUT}`)
console.log(`数据来源：${DATA_SOURCE}`)
console.log(`文件大小：${(Buffer.byteLength(html) / 1024).toFixed(0)} KB　技能 ${data.skills.length} 个`)
