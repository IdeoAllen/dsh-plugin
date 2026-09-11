/**
 * 运维看板 /board —— 一个地址、多个页签，把 /cost、/dshm、/skills 合到同一个浏览器标签里。
 *
 * 为什么用 iframe 而不是把几页重写成一个：各页各自带自己的自动刷新（/dshm 3 秒、
 * /cost 15 秒）和交互（抽屉/搜索/导出）。iframe 同源（都在本次 DSH 端口下）所以能直接嵌，
 * 切换页签只是 display 切换——**iframe 不卸载，自动刷新继续跑**，也不会丢当前视图状态。
 *
 * 布局约定（重要）：本页**刻意不渲染自己的页头**，只提供一条细页签栏。
 * 页面身份交给被嵌入页面自己的页头（cost-manager / dshm / skill-catalog），否则会出现"重复头"。
 *
 * 视觉规范：与 dshm/lib/web/index.html、skill-catalog 看板共用同一套 :root 设计令牌。
 */

/** 页签配置：id → 标题 / 地址 / 说明。新增页签只改这里。 */
const TABS = [
  { id: 'cost', title: '费用与余额', url: '/cost', hint: '各平台余额 · 消耗速率 · 两套账' },
  { id: 'dshm', title: '会话管理', url: '/dshm', hint: '会话列表 · 全文搜索 · 每步 token 趋势 · 导出' },
  { id: 'skills', title: '技能总览', url: '/skills', hint: '是什么 · 干什么用 · 怎么用 · 触发条件 · 关联模型 · 验证级别' },
]

export function renderBoardPage() {
  const tabButtons = TABS.map(
    (t, i) =>
      `<button class="tab${i === 0 ? ' active' : ''}" data-tab="${t.id}" title="${t.hint}">${t.title}</button>`,
  ).join('\n    ')
  const frames = TABS.map(
    (t, i) => `<iframe id="frame-${t.id}" data-tab="${t.id}" src="${t.url}" title="${t.title}"${i === 0 ? '' : ' class="hidden"'}></iframe>`,
  ).join('\n  ')

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>运维看板 · cost-manager + dshm + 技能总览</title>
<!-- 内联图标：否则浏览器会去要 /favicon.ico 并留下一条 404 console 错误 -->
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%230f1115'/%3E%3Ctext x='16' y='22' font-size='16' text-anchor='middle' fill='%235b8cff' font-family='monospace'%3E%E2%96%A0%3C/text%3E%3C/svg%3E">
<style>
  /* ── 设计令牌：与 dshm/lib/web/index.html 保持一致，勿单独改 ───────────── */
  :root {
    --bg: #0f1115;
    --panel: #161a22;
    --panel2: #1c212c;
    --border: #2a3140;
    --text: #e6e9ef;
    --muted: #8b93a5;
    --accent: #5b8cff;
    --green: #3ecf8e;
    --yellow: #f5c542;
    --red: #f26d6d;
    --radius: 10px;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0;
    display: flex; flex-direction: column;
    background: var(--bg);
    color: var(--text);
    font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", Roboto, sans-serif;
  }
  /* 细页签栏：不叫 header、也不放大字号，避免和页面自己的页头"打架" */
  .tabstrip {
    display: flex; align-items: center; gap: 8px;
    padding: 8px 16px; border-bottom: 1px solid var(--border);
    background: var(--panel); flex: 0 0 auto;
  }
  .tab {
    background: transparent; color: var(--muted);
    border: 1px solid transparent; border-radius: 7px;
    padding: 5px 13px; font-size: 13px; cursor: pointer;
  }
  .tab:hover { color: var(--text); border-color: var(--border); }
  .tab.active { background: var(--panel2); color: var(--text); border-color: var(--border); font-weight: 600; }
  .tab .dot { color: var(--red); margin-left: 6px; font-size: 11px; }
  .tab-hint { color: var(--muted); font-size: 12px; margin-left: 6px; }
  .actions { margin-left: auto; display: flex; align-items: center; gap: 12px; }
  .actions a { color: var(--accent); text-decoration: none; font-size: 12.5px; }
  button.mini {
    background: var(--panel2); color: var(--text);
    border: 1px solid var(--border); border-radius: 7px;
    padding: 4px 10px; font-size: 12.5px; cursor: pointer;
  }
  .frames { flex: 1 1 auto; position: relative; min-height: 0; }
  iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; background: var(--bg); }
  iframe.hidden { display: none; }
</style>
</head>
<body>
<nav class="tabstrip">
    ${tabButtons}
  <span class="tab-hint" id="hint"></span>
  <span class="actions">
    <a id="standalone" href="/cost" target="_blank" rel="noopener">独立页 ↗</a>
    <button class="mini" id="reload">重载当前页</button>
  </span>
</nav>

<main class="frames">
  ${frames}
</main>

<script>
var TABS = ${JSON.stringify(TABS)};
var hint = document.getElementById('hint');
var standalone = document.getElementById('standalone');

function current() {
  var active = document.querySelector('.tab.active');
  return active ? active.getAttribute('data-tab') : TABS[0].id;
}

function show(id) {
  var tabs = document.querySelectorAll('.tab');
  for (var i = 0; i < tabs.length; i++) tabs[i].classList.toggle('active', tabs[i].getAttribute('data-tab') === id);
  var frames = document.querySelectorAll('iframe[data-tab]');
  for (var j = 0; j < frames.length; j++) frames[j].classList.toggle('hidden', frames[j].getAttribute('data-tab') !== id);
  var cfg = TABS.filter(function (t) { return t.id === id; })[0];
  hint.textContent = cfg ? cfg.hint : '';
  if (cfg) standalone.href = cfg.url;
  try { window.localStorage.setItem('ops-board-tab', id); } catch (e) { /* 忽略 */ }
  try { window.history.replaceState(null, '', '#' + id); } catch (e) { /* 忽略 */ }
}

document.querySelector('.tabstrip').addEventListener('click', function (e) {
  var btn = e.target.closest ? e.target.closest('.tab') : null;
  if (btn) show(btn.getAttribute('data-tab'));
});

document.getElementById('reload').addEventListener('click', function () {
  var f = document.getElementById('frame-' + current());
  if (f) f.contentWindow.location.reload();
});

/** 预检：某个页签对应页面没就绪（插件没装/没重启）时给出红点提示，而不是白屏。 */
function preflight() {
  TABS.forEach(function (t) {
    fetch(t.url, { method: 'HEAD', cache: 'no-store' })
      .then(function (r) {
        if (r.ok) return;
        var btn = document.querySelector('.tab[data-tab="' + t.id + '"]');
        if (btn) btn.insertAdjacentHTML('beforeend', '<span class="dot" title="该页面未就绪">●</span>');
      })
      .catch(function () { /* 忽略 */ });
  });
}

var initial = TABS[0].id;
try {
  var saved = window.localStorage.getItem('ops-board-tab');
  if (saved && TABS.some(function (t) { return t.id === saved; })) initial = saved;
} catch (e) { /* 忽略 */ }
var fromHash = (window.location.hash || '').replace('#', '').trim();
if (TABS.some(function (t) { return t.id === fromHash; })) initial = fromHash;
show(initial);
preflight();
</script>
</body>
</html>
`
}
