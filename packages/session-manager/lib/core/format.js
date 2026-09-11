// ANSI 颜色 + 中日韩全角宽度感知的排版工具（零依赖）。

let enabled = true;
export function setColorEnabled(on) {
  enabled = on;
}
export function isColorEnabled() {
  return enabled;
}

const R = () => (enabled ? "\u001b[0m" : "");
function paint(text, code) {
  return enabled ? `\u001b[${code}m${text}\u001b[0m` : text;
}

export const c = {
  reset: () => R(),
  bold: (s) => paint(s, 1),
  dim: (s) => paint(s, 2),
  italic: (s) => paint(s, 3),
  underline: (s) => paint(s, 4),
  red: (s) => paint(s, 31),
  green: (s) => paint(s, 32),
  yellow: (s) => paint(s, 33),
  blue: (s) => paint(s, 34),
  magenta: (s) => paint(s, 35),
  cyan: (s) => paint(s, 36),
  white: (s) => paint(s, 37),
  gray: (s) => paint(s, 90),
};

// ---- 显示宽度（CJK/emoji 计 2 列） ----
const ANSI_RE = /\u001b\[[0-9;]*m/g;

function isWideCodePoint(cp) {
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0xa4cf) || // CJK Radicals..Yi
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul Syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK Compatibility Ideographs
    (cp >= 0xfe10 && cp <= 0xfe19) || // Vertical forms
    (cp >= 0xfe30 && cp <= 0xfe6f) || // CJK Compatibility Forms
    (cp >= 0xff00 && cp <= 0xff60) || // Fullwidth Forms
    (cp >= 0xffe0 && cp <= 0xffe6) || // Fullwidth signs
    (cp >= 0x1f300 && cp <= 0x1faff) || // emoji + misc symbols
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK Ext B+
  );
}

export function wswidth(s) {
  if (s == null) return 0;
  const plain = String(s).replace(ANSI_RE, "");
  let w = 0;
  for (const ch of plain) {
    w += isWideCodePoint(ch.codePointAt(0)) ? 2 : 1;
  }
  return w;
}

/** 宽度感知的右填充（不依赖平台 padEnd 的字符计数）。 */
export function padEnd(s, n, fill = " ") {
  const w = wswidth(s);
  return s + fill.repeat(Math.max(0, n - w));
}

/** 宽度感知截断，超长时追加省略号。对纯文本使用（先截断、后着色）。 */
export function truncate(s, n, ellipsis = "…") {
  if (s == null) return "";
  if (wswidth(s) <= n) return s;
  const plain = String(s);
  let out = "";
  let w = 0;
  const elw = wswidth(ellipsis);
  for (const ch of plain) {
    const cw = isWideCodePoint(ch.codePointAt(0)) ? 2 : 1;
    if (w + cw > n - elw) break;
    out += ch;
    w += cw;
  }
  return out + ellipsis;
}

// ---- 数值 / 时间人性化 ----
export function humanMs(ms) {
  if (ms == null || Number.isNaN(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = s / 60;
  if (m < 60) return `${m.toFixed(1)}m`;
  const h = m / 60;
  if (h < 24) return `${h.toFixed(1)}h`;
  return `${(h / 24).toFixed(1)}d`;
}

export function humanNum(n) {
  if (n == null || Number.isNaN(n)) return "—";
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (a >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (a >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return String(Math.round(n));
}

export function humanBytes(n) {
  if (n == null || Number.isNaN(n)) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

export function humanAgo(t) {
  if (t == null) return "—";
  let d = Date.now() - t;
  if (d < 0) d = 0;
  if (d < 60_000) return "刚刚";
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} 分钟前`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} 小时前`;
  if (d < 7 * 86_400_000) return `${Math.floor(d / 86_400_000)} 天前`;
  return fmtDate(t);
}

export function fmtDate(ts) {
  if (ts == null) return "—";
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function pctStr(a, b, digits = 1) {
  if (b == null || b === 0 || a == null) return "—";
  return ((a / b) * 100).toFixed(digits) + "%";
}

// ---- 简单表格 ----
/**
 * 渲染对齐表格。`headers`/`rows` 都是字符串数组（可含 ANSI 颜色）。
 * `aligns` 每个元素为 "left" | "right"。
 */
export function renderTable(headers, rows, opts = {}) {
  const aligns = opts.aligns ?? headers.map(() => "left");
  const pad = opts.pad ?? 2;
  const widths = headers.map((h, i) => {
    let w = wswidth(h);
    for (const r of rows) w = Math.max(w, wswidth(r[i] ?? ""));
    return w;
  });
  const sep = " ".repeat(pad);
  const fmtRow = (cells) =>
    cells
      .map((cell, i) => {
        const s = cell ?? "";
        if (aligns[i] === "right") return " ".repeat(Math.max(0, widths[i] - wswidth(s))) + s;
        return padEnd(s, widths[i]);
      })
      .join(sep)
      .replace(/\s+$/, "");
  const lines = [fmtRow(headers)];
  if (opts.headerSep !== false) {
    lines.push(widths.map((w) => "-".repeat(w)).join(sep));
  }
  for (const r of rows) lines.push(fmtRow(r));
  return lines.join("\n");
}

/** 给多行文本统一加左缩进。 */
export function indent(text, n) {
  const pad = " ".repeat(n);
  return text
    .split("\n")
    .map((l) => (l === "" ? l : pad + l))
    .join("\n");
}

/** 分隔线。 */
export function rule(width = 60, ch = "─") {
  return ch.repeat(width);
}
