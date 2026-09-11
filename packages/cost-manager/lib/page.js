/**
 * 3082 上的实时总览页（替代原来单独进程的 `cost.mjs serve` → 8899）。
 *
 * 视觉规范：与 dshm 的 /dshm 页面**完全同一套语言**——同一组 :root 设计令牌、
 * 同样的 <header> 结构（brand + 副标题 + toolbar）、同样的 .cards/.card/.panel/.foot 语法，
 * 让两个页面看起来是同一个产品的两个看板。改样式时请与 dshm/lib/web/index.html 对齐。
 *
 * 数据走同一份 /dsh-cost/api/overview（余额 45s 缓存、会话扫描 30s 缓存），
 * 自动刷新默认只重取余额卡片，不整页重载。
 */
export function renderCostPage() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>cost-manager · 费用与能力总览</title>
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
  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", Roboto, sans-serif;
  }
  header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 14px 22px; border-bottom: 1px solid var(--border);
    background: var(--panel); position: sticky; top: 0; z-index: 10;
  }
  .brand { font-size: 17px; font-weight: 700; }
  .brand span { color: var(--muted); font-weight: 400; font-size: 13px; margin-left: 8px; }
  .toolbar { display: flex; align-items: center; gap: 16px; }
  .toolbar a { color: var(--accent); text-decoration: none; }
  button {
    background: var(--accent); color: #fff; border: 0; border-radius: 7px;
    padding: 6px 14px; cursor: pointer; font-size: 13px;
  }
  button.ghost { background: var(--panel2); color: var(--text); border: 1px solid var(--border); }
  button:disabled { opacity: .55; cursor: default; }
  label.inline { color: var(--muted); font-size: 13px; display: inline-flex; align-items: center; gap: 6px; cursor: pointer; }
  main { max-width: 1180px; margin: 0 auto; padding: 20px 22px 60px; }

  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; }
  .card {
    background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius);
    padding: 14px 16px;
  }
  .card .k { color: var(--muted); font-size: 12px; }
  .card .v { font-size: 24px; font-weight: 700; margin-top: 4px; }
  .card .sub { color: var(--muted); font-size: 12px; margin-top: 2px; }
  .v.green { color: var(--green); }
  .v.yellow { color: var(--yellow); }
  .v.red { color: var(--red); }

  .panel { margin-top: 16px; background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius); }
  .panel-head {
    display: flex; align-items: center; justify-content: space-between;
    padding: 12px 16px; border-bottom: 1px solid var(--border);
  }
  .panel-head h2 { margin: 0; font-size: 15px; }
  .section-title { margin: 22px 0 10px; font-size: 15px; }

  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 9px 14px; border-bottom: 1px solid var(--border); }
  th { color: var(--muted); font-weight: 500; font-size: 12px; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  tbody tr:last-child td { border-bottom: 0; }
  .muted { color: var(--muted); }
  .empty { padding: 30px; text-align: center; color: var(--muted); }

  .badge { font-size: 11px; padding: 1px 7px; border-radius: 20px; }
  .badge.ok { background: rgba(62,207,142,.15); color: var(--green); }
  .badge.warn { background: rgba(245,197,66,.15); color: var(--yellow); }
  .badge.bad { background: rgba(242,109,109,.15); color: var(--red); }
  .note { color: var(--muted); font-size: 12px; margin-top: 10px; }
  .foot { color: var(--muted); font-size: 12px; margin-top: 20px; }
</style>
</head>
<body>
<header>
  <div class="brand">cost-manager<span>费用与能力总览（非聊天）· 对话请用原生 Web GUI</span></div>
  <div class="toolbar">
    <a href="/dshm" target="_blank" rel="noopener">会话管理 ↗</a>
    <a href="/" target="_blank" rel="noopener">打开 Web GUI ↗</a>
    <label class="inline"><input type="checkbox" id="autoRefresh" checked /> 自动刷新</label>
    <button class="ghost" id="refresh">刷新</button>
  </div>
</header>

<main>
  <section class="cards" id="ledgerCards"></section>
  <div class="note" id="ledgerNote"></div>

  <h2 class="section-title">平台余额与状态</h2>
  <section class="cards" id="balCards"></section>

  <h2 class="section-title">消耗速率（最近窗口）</h2>
  <section class="cards" id="burnCards"></section>

  <h2 class="section-title">LLM 用量</h2>
  <section class="cards" id="usageCards"></section>

  <section class="panel">
    <div class="panel-head"><h2>账 B · 实付记账分布（按平台）</h2></div>
    <table>
      <thead>
        <tr><th>平台</th><th class="num">笔数</th><th class="num">待补</th><th class="num">金额</th></tr>
      </thead>
      <tbody id="ledgerRows"></tbody>
    </table>
    <div class="empty" id="ledgerEmpty" style="display:none">还没有实付记账记录</div>
  </section>

  <div class="foot" id="foot">加载中…</div>
</main>

<script>
var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); };
var money = function (n) { var v = Number(n); return '¥' + (isFinite(v) ? v.toFixed(2) : '—'); };
var money3 = function (n) { var v = Number(n); return '¥' + (isFinite(v) ? v.toFixed(3) : '—'); };
var fmtTok = function (n) { var v = Number(n) || 0; return v >= 1e6 ? (v / 1e6).toFixed(2) + 'M' : v >= 1e3 ? Math.round(v / 1e3) + 'K' : String(v); };
var cny = function (s) { var m = String(s == null ? '' : s).match(/¥([0-9.]+)/); return m ? Number(m[1]) : null; };
var hours = function (h) { return h == null || !isFinite(h) ? '—' : (h < 48 ? h.toFixed(1) + ' 小时' : (h / 24).toFixed(1) + ' 天'); };

function card(k, v, sub, cls) {
  return '<div class="card"><div class="k">' + esc(k) + '</div><div class="v ' + (cls || '') + '">' + v + '</div>' +
    (sub ? '<div class="sub">' + sub + '</div>' : '') + '</div>';
}

function renderLedger(j) {
  var u = j.usage || {}, L = j.ledger || {};
  document.getElementById('ledgerCards').innerHTML =
    card('账 A · LLM 用量估费', money(u.cost), fmtTok(u.tokens) + ' token · ' + (u.msgs || 0) + ' 条消息') +
    card('账 B · 实付记账', money3(L.total), (L.count || 0) + ' 笔 · 图片/视频/数字人等按次付费') +
    card('账 B · 成本待补', (L.pending || 0) + ' 笔', L.pending ? '有记录缺成本，需补记' : '无需待补', L.pending ? 'yellow' : '');
  document.getElementById('ledgerNote').textContent =
    '账 A ＝「按 token 估的模型调用消耗」，来自会话日志自动扫描；账 B ＝「逐笔登记的按次付费」，来自 ledger.jsonl。两者口径不同，不能相加。';
}

function renderBalances(j) {
  var floors = j.floors || {}, alerts = j.alerts || {};
  document.getElementById('balCards').innerHTML = (j.balances || []).map(function (b) {
    var v = cny(b.balance), f = floors[b.platform], a = alerts[b.platform];
    var below = v !== null && f !== undefined && v < f, low = v !== null && a !== undefined && v < a;
    var cls = below ? 'red' : low ? 'yellow' : '';
    var badge = below ? '<span class="badge bad">⛔ 低于硬地板 ' + money(f) + '</span>'
      : low ? '<span class="badge warn">⚠️ 低于预警线 ' + money(a) + '</span>'
      : esc(b.status || '');
    return card(b.platform, esc(b.balance || '—'), badge, cls);
  }).join('');
}

function renderBurn(j) {
  var burn = (j.burn && j.burn.byPlatform) || [];
  var floors = j.floors || {};
  var head = '最近 ' + ((j.burn && j.burn.windowHours) || 6) + 'h 窗口 · 活跃跨度 ' + (((j.burn && j.burn.spanHours) || 0).toFixed(1)) + 'h';
  if (!burn.length) {
    document.getElementById('burnCards').innerHTML = card('无会话活动', '—', head);
    return;
  }
  document.getElementById('burnCards').innerHTML = burn.map(function (b) {
    var row = (j.balances || []).filter(function (x) { return x.platform === b.platform; })[0];
    var bal = row ? cny(row.balance) : null, f = floors[b.platform];
    var sub = head, cls = '';
    if (bal !== null && f !== undefined && b.ratePerHour > 0) {
      var h = (bal - f) / b.ratePerHour;
      sub = '距硬地板 ' + money(f) + ' 可撑 ' + hours(h) + (h < 2 ? ' ⚠️' : '');
      if (h < 2) cls = 'red';
    }
    return card(b.platform, money(b.ratePerHour) + '/h', sub, cls);
  }).join('');
}

function renderUsage(j) {
  var u = j.usage || {};
  document.getElementById('usageCards').innerHTML =
    card('估费', money(u.cost), '按模型单价分价、缓存命中单算') +
    card('token', fmtTok(u.tokens), '输入 + 输出 + 思考') +
    card('消息', String(u.msgs || 0), '自动扫描 DSH 会话');
}

function renderLedgerTable(j) {
  var rows = ((j.ledger || {}).byPlatform) || [];
  document.getElementById('ledgerEmpty').style.display = rows.length ? 'none' : 'block';
  document.getElementById('ledgerRows').innerHTML = rows.map(function (p) {
    return '<tr><td>' + esc(p.platform) + '</td><td class="num">' + p.count + '</td>' +
      '<td class="num' + (p.pending ? ' muted' : '') + '">' + (p.pending || '—') + '</td>' +
      '<td class="num">' + money3(p.cost) + '</td></tr>';
  }).join('');
}

function renderFoot(j) {
  var scan = j.scan || {}, L = j.ledger || {};
  var bits = [
    '更新 ' + new Date(j.updatedAt).toLocaleString('zh-CN'),
    '会话扫描：' + (scan.cached ? '命中缓存' : '重解析 ' + (scan.reparsedFiles == null ? '?' : scan.reparsedFiles) + ' 个文件'),
    scan.failedFiles ? '<span class="badge bad">' + scan.failedFiles + ' 个会话读取失败</span>' : '',
    '账 B 文件：' + esc(L.path || '（未找到）'),
  ].filter(Boolean);
  document.getElementById('foot').innerHTML = bits.join('　·　');
}

var loading = false;
function load(force) {
  if (loading) return;
  loading = true;
  var btn = document.getElementById('refresh');
  btn.disabled = true;
  btn.textContent = '刷新中…';
  fetch('/dsh-cost/api/overview' + (force ? '?force=1' : ''), { cache: 'no-store' })
    .then(function (r) { return r.json(); })
    .then(function (j) {
      if (!j || !j.ok) throw new Error((j && j.error) || '返回数据异常');
      renderLedger(j);
      renderBalances(j);
      renderBurn(j);
      renderUsage(j);
      renderLedgerTable(j);
      renderFoot(j);
    })
    .catch(function (e) {
      document.getElementById('foot').innerHTML = '<span class="badge bad">加载失败</span> ' + esc(e.message);
    })
    .finally(function () {
      loading = false;
      btn.disabled = false;
      btn.textContent = '刷新';
    });
}

/** 自动刷新只重取余额/速率卡片与页脚，避免整页跳动。 */
function refreshBalancesOnly() {
  fetch('/dsh-cost/api/overview', { cache: 'no-store' })
    .then(function (r) { return r.json(); })
    .then(function (j) { if (j && j.ok) { renderBalances(j); renderBurn(j); renderFoot(j); } })
    .catch(function () { /* 网络抖动时静默，下个周期再试 */ });
}

var timer = null;
function setAuto(on) {
  if (timer) { clearInterval(timer); timer = null; }
  if (on) timer = setInterval(refreshBalancesOnly, 15000);
}

document.getElementById('refresh').addEventListener('click', function () { load(true); });
document.getElementById('autoRefresh').addEventListener('change', function (e) { setAuto(e.target.checked); });
load(false);
setAuto(true);
</script>
</body>
</html>
`
}
