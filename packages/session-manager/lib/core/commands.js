import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { loadStore, setSessionArchived } from "./store.js";
import { transcriptOfSession, searchAll, trendSeries, findSessionLog } from "./logs.js";
import {
  c,
  wswidth,
  padEnd,
  truncate,
  humanMs,
  humanNum,
  humanAgo,
  fmtDate,
  pctStr,
  renderTable,
  indent,
  rule,
} from "./format.js";

// Web GUI 地址：优先 DSH 自己注入的 DSH_WEB_URL（在 DSH 的 shell 里天然是对的），
// 其次 DSHM_WEB_URL 显式覆盖，最后回落到当前默认端口 3082。
// 注意 dshm 可能指向不同的 DSH 主目录（--home / DSH_HOME），端口未必一致，故留环境变量覆盖口。
export const WEB_URL = () =>
  process.env.DSH_WEB_URL || process.env.DSHM_WEB_URL || "http://127.0.0.1:3082";

function shortId(id) {
  return id ? id.replace(/^session-/, "").slice(0, 8) : "";
}

function idKey(id) {
  return id.replace(/^session-/, "").toLowerCase();
}

/** 依据完整 id 或 uuid 前缀定位会话。 */
export function resolveSession(store, q) {
  if (!q) return null;
  const target = idKey(q);
  const exact = store.sessions.find((s) => idKey(s.id) === target);
  if (exact) return exact;
  const prefixes = store.sessions.filter((s) => idKey(s.id).startsWith(target));
  if (prefixes.length === 1) return prefixes[0];
  if (prefixes.length > 1) return { ambiguous: prefixes };
  const contains = store.sessions.filter((s) => idKey(s.id).includes(target));
  if (contains.length === 1) return contains[0];
  if (contains.length > 1) return { ambiguous: contains };
  return null;
}

export function sessionUri(id) {
  return "dsh-session:" + Buffer.from(JSON.stringify(id), "utf8").toString("base64url");
}

function isAmbiguous(r) {
  return r && typeof r === "object" && Array.isArray(r.ambiguous);
}

function aggregate(sessions) {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let maxContextPct = null;
  let maxSurface = 0;
  for (const s of sessions) {
    inputTokens += s.inputTokens ?? 0;
    outputTokens += s.outputTokens ?? 0;
    cacheReadTokens += s.cacheReadTokens ?? 0;
    cacheWriteTokens += s.cacheWriteTokens ?? 0;
    if (s.contextPct != null && (maxContextPct == null || s.contextPct > maxContextPct)) {
      maxContextPct = s.contextPct;
    }
    if ((s.contextUsed ?? 0) > maxSurface) maxSurface = s.contextUsed ?? 0;
  }
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, maxContextPct, maxSurface };
}

/** 目标在缓存中的形状为 { goal: GoalView, roundsStarted, createdAt, updatedAt }。 */
export function goalInfo(rawGoal) {
  if (!rawGoal) return null;
  const g = rawGoal.goal && typeof rawGoal.goal === "object" ? rawGoal.goal : rawGoal;
  return {
    id: g.id ?? null,
    objective: g.objective ?? null,
    phase: g.phase ?? null,
    revision: g.revision ?? null,
    maxGoalRounds: g.maxGoalRounds ?? null,
    blockedReason: g.blockedReason ?? null,
    roundsStarted: rawGoal.roundsStarted ?? null,
    createdAt: rawGoal.createdAt ?? null,
    updatedAt: rawGoal.updatedAt ?? null,
  };
}

// ---------------------------------------------------------------------------
// 状态 / 概览（借鉴 Claude Code 的 /status 与 /cost）
// ---------------------------------------------------------------------------

export function statusSnapshot(store) {
  const agg = aggregate(store.sessions);
  const activeGoal = store.sessions.find((s) => s.goal) ?? null;
  const archivedCount = [...store.archivedSet].filter((id) => store.sessionsById.has(id)).length;
  const recent = store.sessions.filter((s) => !s.archived).slice(0, 5);
  return {
    home: store.home,
    webUrl: WEB_URL(),
    model: store.settings["agent-default-model"] ?? null,
    workspaces: store.workspaces.length,
    sessions: store.sessions.length,
    archived: archivedCount,
    goal: activeGoal
      ? { sessionId: activeGoal.id, ...goalInfo(activeGoal.goal) }
      : null,
    usage: {
      inputTokens: agg.inputTokens,
      outputTokens: agg.outputTokens,
      cacheReadTokens: agg.cacheReadTokens,
      cacheWriteTokens: agg.cacheWriteTokens,
      maxContextPct: agg.maxContextPct,
      maxSurfaceTokens: agg.maxSurface,
    },
    recent: recent.map((s) => ({
      id: s.id,
      title: s.title,
      workspace: s.wsTitle,
      updatedAt: s.updatedAt,
      turns: s.turns,
      contextPct: s.contextPct,
    })),
  };
}

function section(title) {
  return "\n  " + c.bold(title) + "\n";
}

function renderGoalLine(store) {
  const g = store.sessions.find((s) => s.goal);
  if (!g) return "  " + padEnd("当前目标", 10) + c.dim("（无活跃目标）");
  const info = goalInfo(g.goal);
  const obj = info && info.objective ? truncate(info.objective, 60) : JSON.stringify(g.goal);
  return (
    "  " +
    padEnd("当前目标", 10) +
    obj +
    "  " +
    c.dim(`(${shortId(g.id)} · ${info.phase ?? "?"} · round ${info.roundsStarted ?? 0}/${info.maxGoalRounds ?? "?"})`)
  );
}

export function renderStatus(store) {
  const agg = aggregate(store.sessions);
  const dm = store.settings["agent-default-model"];
  const archivedCount = [...store.archivedSet].filter((id) => store.sessionsById.has(id)).length;
  const out = [];
  out.push("");
  out.push("  " + c.bold("DeepSeek Harness 管理终端") + "  " + c.dim("dshm v0.1.0"));
  out.push("  " + c.dim(rule(Math.max(40, wswidth("DeepSeek Harness 管理终端  dshm v0.1.0")))));
  out.push("  " + padEnd(c.dim("DSH 主目录"), 12) + store.home);
  out.push("  " + padEnd(c.dim("Web GUI"), 12) + WEB_URL());
  if (dm) {
    out.push(
      "  " + padEnd(c.dim("默认模型"), 12) + `${dm.provider ?? "?"} / ${dm.model ?? "?"}`
    );
  }
  out.push(section("概览"));
  out.push(
    "  " +
      padEnd("工作区", 10) +
      c.bold(String(store.workspaces.length)) +
      " 个" +
      c.dim(`   ·   会话 ${store.sessions.length} 个   ·   已归档 ${archivedCount} 个`)
  );
  out.push("  " + renderGoalLine(store));
  out.push(section("用量汇总"));
  out.push("  " + padEnd("输出 token", 12) + humanNum(agg.outputTokens));
  out.push("  " + padEnd("输入 token", 12) + humanNum(agg.inputTokens));
  out.push("  " + padEnd("缓存读取", 12) + humanNum(agg.cacheReadTokens));
  out.push(
    "  " +
      padEnd("上下文峰值", 12) +
      (agg.maxContextPct != null ? agg.maxContextPct.toFixed(1) + "%" : "—") +
      (agg.maxSurface ? c.dim(`  (${humanNum(agg.maxSurface)} tokens)`) : "")
  );
  const recent = store.sessions.filter((s) => !s.archived).slice(0, 5);
  if (recent.length) {
    out.push(section("最近会话"));
    const headers = ["会话", "工作区", "标题", "更新时间", "轮次", "上下文"];
    const rows = recent.map((s) => [
      shortId(s.id),
      s.wsTitle ?? c.dim("未分组"),
      truncate(s.title || "(未命名)", 24),
      humanAgo(s.updatedAt),
      String(s.turns ?? "—"),
      s.contextPct != null ? s.contextPct.toFixed(1) + "%" : "—",
    ]);
    out.push(indent(renderTable(headers, rows), 2));
  }
  out.push("");
  out.push("  " + c.dim("命令：status · ls · show <id> · usage · workspaces · goal · resume · archive · help"));
  return out.join("\n");
}

export function cmdStatus(store, opts) {
  if (opts.json) return JSON.stringify(statusSnapshot(store), null, 2);
  return renderStatus(store);
}

// ---------------------------------------------------------------------------
// 工作区
// ---------------------------------------------------------------------------

export function cmdWorkspaces(store, opts) {
  if (opts.json) {
    return JSON.stringify(
      store.workspaces.map((w) => ({
        id: w.id,
        title: w.title,
        path: w.path,
        sessions: w.sessionIds.length,
        createdAt: w.createdAt,
        updatedAt: w.updatedAt,
      })),
      null,
      2
    );
  }
  if (!store.workspaces.length) return c.dim("（暂无工作区）");
  const headers = ["标题", "路径", "会话", "创建时间", "最近更新"];
  const rows = store.workspaces.map((w) => [
    w.title ?? c.dim("(未命名)"),
    w.path ?? "—",
    String(w.sessionIds.length),
    fmtDate(w.createdAt),
    fmtDate(w.updatedAt),
  ]);
  return renderTable(headers, rows);
}

// ---------------------------------------------------------------------------
// 会话列表（借鉴 Codex CLI 的 resume 会话选择列表）
// ---------------------------------------------------------------------------

export function cmdList(store, opts) {
  const list = store.sessions.filter((s) => (opts.all ? true : !s.archived));
  if (opts.json) {
    return JSON.stringify(
      list.map((s) => ({
        id: s.id,
        title: s.title,
        workspace: s.wsTitle,
        cwd: s.cwd,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        turns: s.turns,
        steps: s.steps,
        outputTokens: s.outputTokens,
        inputTokens: s.inputTokens,
        contextPct: s.contextPct,
        archived: s.archived,
      })),
      null,
      2
    );
  }
  if (!list.length) return c.dim("（暂无会话）");
  const headers = ["会话", "工作区", "标题", "更新时间", "轮次", "输出", "上下文"];
  const rows = list.map((s) => [
    shortId(s.id) + (s.archived ? c.dim(" 归档") : ""),
    s.wsTitle ?? c.dim("未分组"),
    truncate(s.title || "(未命名)", 26),
    humanAgo(s.updatedAt),
    String(s.turns ?? "—"),
    humanNum(s.outputTokens),
    s.contextPct != null ? s.contextPct.toFixed(1) + "%" : "—",
  ]);
  const grouped = renderTable(headers, rows);
  const archivedInCache = [...store.archivedSet].filter((id) => store.sessionsById.has(id)).length;
  const note = opts.all
    ? `共 ${list.length} 个会话（含归档）`
    : `共 ${list.length} 个会话 · 隐藏 ${archivedInCache} 个归档（--all 查看）`;
  return grouped + "\n" + c.dim(note);
}

// ---------------------------------------------------------------------------
// 会话详情（借鉴 Claude Code 的 /usage 详情）
// ---------------------------------------------------------------------------

export function cmdShow(store, id, opts) {
  const r = resolveSession(store, id);
  if (!r) return c.red(`未找到会话：${id ?? "(未提供)"}`);
  if (isAmbiguous(r)) {
    return (
      c.yellow("匹配到多个会话：") +
      "\n" +
      r.ambiguous.map((s) => `  - ${s.id}`).join("\n")
    );
  }
  const s = r;
  if (opts.json) {
    return JSON.stringify(
      {
        id: s.id,
        title: s.title,
        workspace: s.wsTitle,
        cwd: s.cwd,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        archived: s.archived,
        stats: s.stats,
        tokenUsage: s.tokenUsage,
        contextPressure: s.contextPressure,
        contextBreakdown: s.contextBreakdown,
        permissions: s.permissions,
        goal: s.goal,
        todos: s.todos,
        plan: s.plan,
        resumeUri: sessionUri(s.id),
        webUrl: WEB_URL(),
      },
      null,
      2
    );
  }
  const out = [];
  out.push("");
  out.push("  " + c.bold("会话 " + s.id) + (s.archived ? c.yellow("  [已归档]") : ""));
  out.push("  " + c.dim(rule(70)));
  const kv = (label, value) => "  " + padEnd(label, 14) + (value ?? "—");
  out.push(kv("标题", s.title || c.dim("(未命名)")));
  out.push(kv("工作区", s.wsTitle ? `${s.wsTitle}  ${c.dim(s.cwd ?? "")}` : c.dim("未分组")));
  out.push(kv("创建时间", fmtDate(s.createdAt)));
  out.push(kv("更新时间", fmtDate(s.updatedAt) + "  " + c.dim(humanAgo(s.updatedAt))));
  out.push(kv("状态", s.archived ? c.yellow("已归档") : c.green("活跃")));

  out.push(section("统计"));
  out.push(kv("轮次", s.turns));
  out.push(kv("步骤", s.steps));
  out.push(kv("LLM 用时", humanMs(s.llmMs)));
  out.push(kv("工具用时", humanMs(s.toolMs)));
  out.push(kv("首 token", humanMs(s.ttftMs)));
  out.push(kv("解码 token", s.decodeTokens != null ? `${humanNum(s.decodeTokens)} (${humanMs(s.decodeMs)})` : "—"));

  out.push(section("Token 用量"));
  out.push(kv("输入(未缓存)", humanNum(s.inputTokens)));
  out.push(kv("输出", humanNum(s.outputTokens)));
  out.push(kv("缓存读取", humanNum(s.cacheReadTokens)));
  out.push(kv("缓存写入", humanNum(s.cacheWriteTokens)));

  out.push(section("上下文"));
  const cb = s.contextBreakdown ?? {};
  out.push(
    kv(
      "表层 token",
      s.contextUsed != null
        ? `${humanNum(s.contextUsed)} / ${humanNum(s.contextWindow)}  (${s.contextPct != null ? s.contextPct.toFixed(1) + "%" : "—"})`
        : "—"
    )
  );
  out.push(kv("系统", cb.systemTokens != null ? humanNum(cb.systemTokens) : "—"));
  out.push(kv("工具", cb.toolsTokens != null ? humanNum(cb.toolsTokens) : "—"));
  out.push(kv("消息", cb.messageTokens != null ? humanNum(cb.messageTokens) : "—"));

  if (s.permissions) {
    out.push(section("权限"));
    out.push(kv("预设", s.permissions.preset ?? "—"));
    out.push(kv("沙箱", s.permissions.sandbox ?? "—"));
    out.push(kv("审批", s.permissions.approval ?? "—"));
  }

  out.push(section("目标"));
  const info = goalInfo(s.goal);
  if (info) {
    out.push("  " + (info.objective ?? JSON.stringify(s.goal)));
    if (info.phase) out.push("  " + kv("阶段", info.phase));
    if (info.revision != null) out.push("  " + kv("revision", info.revision));
    if (info.maxGoalRounds != null) {
      out.push("  " + kv("轮次", `${info.roundsStarted ?? 0} / ${info.maxGoalRounds}`));
    }
    if (info.blockedReason != null) out.push("  " + kv("阻塞原因", info.blockedReason));
  } else {
    out.push("  " + c.dim("（无）"));
  }

  if (Array.isArray(s.todos) && s.todos.length) {
    out.push(section("待办"));
    for (const t of s.todos) {
      const content = typeof t === "string" ? t : t?.content;
      const status = typeof t === "string" ? null : t?.status;
      const mark = status === "completed" ? c.green("✓") : status === "in_progress" ? c.yellow("▶") : "·";
      out.push(`  ${mark} ${content ?? ""}`);
    }
  }

  out.push(section("恢复"));
  out.push("  " + c.dim("引用 URI ") + sessionUri(s.id));
  out.push("  " + c.dim("Web GUI  ") + WEB_URL());
  out.push("");
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// 用量汇总（借鉴 Claude Code 的 /cost）
// ---------------------------------------------------------------------------

export function cmdUsage(store, opts) {
  const agg = aggregate(store.sessions);
  if (opts.json) {
    return JSON.stringify(
      {
        totals: {
          inputTokens: agg.inputTokens,
          outputTokens: agg.outputTokens,
          cacheReadTokens: agg.cacheReadTokens,
          cacheWriteTokens: agg.cacheWriteTokens,
        },
        perSession: store.sessions.map((s) => ({
          id: s.id,
          inputTokens: s.inputTokens,
          outputTokens: s.outputTokens,
          cacheReadTokens: s.cacheReadTokens,
          contextPct: s.contextPct,
        })),
      },
      null,
      2
    );
  }
  const out = [];
  out.push(section("全局用量"));
  out.push("  " + padEnd("输出 token", 14) + humanNum(agg.outputTokens));
  out.push("  " + padEnd("输入 token", 14) + humanNum(agg.inputTokens));
  out.push("  " + padEnd("缓存读取", 14) + humanNum(agg.cacheReadTokens));
  out.push("  " + padEnd("缓存写入", 14) + humanNum(agg.cacheWriteTokens));
  out.push(section("按会话"));
  const headers = ["会话", "工作区", "输入", "输出", "缓存读取", "上下文"];
  const rows = store.sessions.map((s) => [
    shortId(s.id),
    s.wsTitle ?? c.dim("未分组"),
    humanNum(s.inputTokens),
    humanNum(s.outputTokens),
    humanNum(s.cacheReadTokens),
    s.contextPct != null ? s.contextPct.toFixed(1) + "%" : "—",
  ]);
  out.push(indent(renderTable(headers, rows), 2));
  out.push("");
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// 目标
// ---------------------------------------------------------------------------

export function cmdGoal(store, opts) {
  const goals = store.sessions.filter((s) => s.goal);
  if (opts.json) {
    return JSON.stringify(
      goals.map((s) => ({ sessionId: s.id, ...s.goal })),
      null,
      2
    );
  }
  if (!goals.length) return c.dim("（无活跃目标）");
  const out = [];
  for (const s of goals) {
    const info = goalInfo(s.goal);
    out.push("  " + c.bold("会话 " + shortId(s.id)) + "  " + c.dim(s.wsTitle ?? "未分组"));
    out.push("  " + (info.objective ?? JSON.stringify(s.goal)));
    if (info.phase) out.push("  阶段 " + info.phase);
    if (info.revision != null) out.push("  revision " + info.revision);
    if (info.maxGoalRounds != null) out.push("  轮次 " + (info.roundsStarted ?? 0) + " / " + info.maxGoalRounds);
    if (info.blockedReason != null) out.push("  阻塞原因 " + info.blockedReason);
    out.push("");
  }
  return out.join("\n").trimEnd();
}

// ---------------------------------------------------------------------------
// 恢复（借鉴 Codex CLI 的 resume；web profile 无 CLI resume 标志，
// 因此产出 dsh-session 引用 URI 并可选打开 Web GUI）
// ---------------------------------------------------------------------------

export function cmdResume(store, id, opts) {
  const r = resolveSession(store, id);
  if (!r) {
    if (id) return c.red(`未找到会话：${id}`);
    // 无参数 → 交互选择器
    return pickResume(store, opts);
  }
  if (isAmbiguous(r)) {
    return (
      c.yellow("匹配到多个会话：") +
      "\n" +
      r.ambiguous.map((s) => `  - ${s.id}`).join("\n")
    );
  }
  return resumeOne(r, opts);
}

function resumeOne(s, opts) {
  const uri = sessionUri(s.id);
  const url = WEB_URL();
  const out = [];
  out.push("");
  out.push("  " + c.bold("恢复会话") + "  " + c.dim(shortId(s.id)));
  out.push("  " + padEnd("标题", 10) + (s.title || "(未命名)"));
  out.push("  " + padEnd("工作区", 10) + (s.wsTitle ?? "未分组"));
  out.push("  " + padEnd("路径", 10) + (s.cwd ?? "—"));
  out.push("  " + padEnd("引用 URI", 10) + uri);
  out.push("  " + padEnd("Web GUI", 10) + url);
  out.push("");
  out.push("  " + c.dim("在 Web GUI 侧边栏选择该会话即可继续对话；引用 URI 可用于跨会话 @mention。"));
  if (opts.open) {
    openBrowser(url);
    out.push("  " + c.dim("已尝试在默认浏览器打开 Web GUI。"));
  }
  return out.join("\n");
}

function pickResume(store, opts) {
  const list = store.sessions.filter((s) => !s.archived);
  if (!list.length) return c.dim("（暂无可恢复的会话）");
  const headers = ["#", "会话", "工作区", "标题", "更新时间"];
  const rows = list.map((s, i) => [
    String(i + 1),
    shortId(s.id),
    s.wsTitle ?? c.dim("未分组"),
    truncate(s.title || "(未命名)", 26),
    humanAgo(s.updatedAt),
  ]);
  return (
    renderTable(headers, rows) +
    "\n\n" +
    c.dim(`用法：dshm resume <编号|id>   （共 ${list.length} 个会话）`)
  );
}

export function openBrowser(url) {
  try {
    const cmd = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
    const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.unref();
  } catch {
    /* 忽略打开失败 */
  }
}

// ---------------------------------------------------------------------------
// 归档 / 取消归档
// ---------------------------------------------------------------------------

export function cmdArchive(store, ids, opts) {
  return archiveSwitch(store, ids, true);
}

export function cmdUnarchive(store, ids, opts) {
  return archiveSwitch(store, ids, false);
}

function archiveSwitch(store, ids, archived) {
  if (!Array.isArray(ids) || !ids.length) {
    return c.red("缺少会话 id（可多个）：archive <id1> [id2 ...]");
  }
  const done = [];
  const skipped = [];
  for (const id of ids) {
    const r = resolveSession(store, id);
    if (!r) {
      skipped.push(id + "（未找到）");
      continue;
    }
    if (isAmbiguous(r)) {
      skipped.push(id + "（不唯一）");
      continue;
    }
    setSessionArchived(store.home, r.id, archived);
    done.push(r.id + "  " + c.dim("(" + (r.title || "未命名") + ")"));
  }
  const out = [c.bold((archived ? "已归档" : "已取消归档") + " " + done.length + " 个会话")];
  out.push(...done.map((d) => "  " + d));
  if (skipped.length) out.push(c.yellow("跳过 " + skipped.length + " 个：") + skipped.join(" · "));
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// 导出 / 备份 / 搜索 / 趋势（基于会话日志）
// ---------------------------------------------------------------------------

function exportTimestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function renderMarkdown(s, t) {
  const L = [];
  L.push(`# ${t.title ?? s.title ?? "会话 " + s.id}`);
  L.push("");
  L.push(`- 会话 ID: \`${s.id}\``);
  L.push(`- 工作区: ${s.wsTitle ?? "未分组"}`);
  L.push(`- 路径: ${s.cwd ?? "—"}`);
  L.push(`- 创建时间: ${fmtDate(s.createdAt)}`);
  L.push(`- 导出时间: ${new Date().toLocaleString()}`);
  L.push(`- 轮次: ${s.turns ?? "—"} · 步骤: ${s.steps ?? "—"}`);
  L.push(`- Token: 输入 ${humanNum(s.inputTokens)} · 输出 ${humanNum(s.outputTokens)} · 缓存读取 ${humanNum(s.cacheReadTokens)}`);
  L.push("");
  for (const m of t.messages) {
    L.push("---");
    L.push("");
    if (m.role === "user") {
      L.push(`### 👤 用户${m.time ? " · " + fmtDate(m.time) : ""}`);
      L.push("");
      L.push(m.text);
    } else {
      const meta = [m.time ? fmtDate(m.time) : null, m.model, m.step != null ? "步骤 " + m.step : null]
        .filter(Boolean)
        .join(" · ");
      L.push(`### 🤖 助手 · ${meta}`);
      if (m.usage) {
        L.push("");
        L.push(`_输入 ${m.usage.inputTokens ?? 0} · 输出 ${m.usage.outputTokens ?? 0} · 缓存读取 ${m.usage.cacheReadTokens ?? 0} token_`);
      }
      L.push("");
      if (m.text) L.push(m.text);
      if (m.reasoning) {
        L.push("");
        L.push("<details><summary>推理</summary>");
        L.push("");
        L.push(m.reasoning);
        L.push("");
        L.push("</details>");
      }
      for (const tc of m.toolCalls) {
        L.push("");
        L.push(`- 🛠️ 工具 \`${tc.name ?? "?"}\``);
        if (tc.arguments) {
          let pretty = tc.arguments;
          try {
            pretty = JSON.stringify(JSON.parse(tc.arguments), null, 2);
          } catch {
            /* keep raw */
          }
          L.push("");
          L.push("```json");
          L.push(pretty);
          L.push("```");
        }
      }
    }
    L.push("");
  }
  return L.join("\n");
}

export function cmdExport(store, args, opts) {
  const format = opts.format ?? "md";
  const outDir = opts.out ?? join(process.cwd(), "dshm-export");
  let ids = (Array.isArray(args) ? args : []).filter(Boolean);
  if (opts.all || ids.length === 0) {
    ids = store.sessions.filter((s) => !s.archived).map((s) => s.id);
  }
  if (!ids.length) return c.dim("（没有可导出的会话）");
  mkdirSync(outDir, { recursive: true });
  const written = [];
  const skipped = [];
  for (const id of ids) {
    const r = resolveSession(store, id);
    if (!r || isAmbiguous(r)) {
      skipped.push(id);
      continue;
    }
    const t = transcriptOfSession(store.home, r.id);
    if (!t) {
      skipped.push(id);
      continue;
    }
    const safe = r.id.replace(/[^a-zA-Z0-9._-]/g, "_");
    if (format === "json") {
      const file = join(outDir, safe + ".json");
      writeFileSync(
        file,
        JSON.stringify(
          {
            sessionId: r.id,
            title: t.title ?? r.title,
            workspace: r.wsTitle,
            cwd: r.cwd,
            header: t.header,
            messages: t.messages,
          },
          null,
          2
        ) + "\n",
        "utf8"
      );
      written.push(file);
    } else {
      const file = join(outDir, safe + ".md");
      writeFileSync(file, renderMarkdown(r, t), "utf8");
      written.push(file);
    }
  }
  const out = [c.bold(`已导出 ${written.length} 个会话 → ${outDir}`)];
  out.push(...written.map((f) => "  " + f));
  if (skipped.length) out.push(c.yellow("跳过（无日志或 id 不唯一）：") + skipped.join(" · "));
  return out.join("\n");
}

function copyIfExists(src, dest) {
  if (existsSync(src)) {
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
    return true;
  }
  return false;
}

export function cmdBackup(store, args, opts) {
  const outDir = opts.out ?? join(process.cwd(), "dshm-backup-" + exportTimestamp());
  mkdirSync(outDir, { recursive: true });
  let meta = 0;
  meta += copyIfExists(join(store.home, "storages", "workspace.json"), join(outDir, "workspace.json")) ? 1 : 0;
  meta += copyIfExists(join(store.home, "storages", "session_projcache.json"), join(outDir, "session_projcache.json")) ? 1 : 0;
  meta += copyIfExists(join(store.home, "settings.yaml"), join(outDir, "settings.yaml")) ? 1 : 0;
  let logs = 0;
  for (const s of store.sessions) {
    const p = findSessionLog(store.home, s.id);
    if (!p) continue;
    const dest = join(outDir, "sessions", s.id, basename(p));
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(p, dest);
    logs++;
  }
  return c.bold(`已备份 ${logs} 个会话日志 + ${meta} 个元数据文件 → ${outDir}`);
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function highlight(text, q) {
  return text.replace(new RegExp(escapeRegExp(q), "gi"), (m) => c.red(c.bold(m)));
}

export function cmdSearch(store, args, opts) {
  const q = (Array.isArray(args) ? args : []).join(" ").trim();
  if (!q) throw new Error("search 需要一个查询词：dshm search <关键词>");
  const results = searchAll(store.home, q, {
    limit: opts.limit ?? 20,
    includeArchived: !!opts.all,
    includeReasoning: !!opts.reasoning,
  });
  if (opts.json) return JSON.stringify(results, null, 2);
  if (!results.length) return c.dim(`未找到 “${q}” 的匹配`);
  const out = [c.bold(`搜索 “${q}” · ${results.length} 条命中`)];
  for (const r of results) {
    out.push("");
    out.push(
      "  " +
        c.bold(r.shortId) +
        "  " +
        c.dim(r.workspace ?? "未分组") +
        "  " +
        (r.role === "user" ? c.cyan("[用户]") : c.green("[助手]")) +
        (r.model ? "  " + c.dim(r.model) : "") +
        (r.time ? "  " + c.dim(humanAgo(r.time)) : "")
    );
    out.push("  " + highlight(r.snippet, q));
  }
  return out.join("\n");
}

function sparkline(values, width = 60) {
  if (!values.length) return "";
  const max = Math.max(...values, 1);
  const chars = "▁▂▃▄▅▆▇█";
  const bucket = Math.max(1, Math.ceil(values.length / width));
  let out = "";
  for (let i = 0; i < values.length; i += bucket) {
    const slice = values.slice(i, i + bucket);
    const v = slice.reduce((a, b) => a + b, 0) / slice.length;
    out += chars[Math.round((v / max) * (chars.length - 1))];
  }
  return out;
}

function sum(arr) {
  return arr.reduce((a, b) => a + b, 0);
}

export function cmdTrend(store, id, opts) {
  const r = resolveSession(store, id);
  if (!r) return c.red(`未找到会话：${id ?? "(未提供)"}`);
  if (isAmbiguous(r)) {
    return c.yellow("匹配到多个会话，请提供更完整的 id：\n" + r.ambiguous.map((s) => `  - ${s.id}`).join("\n"));
  }
  const points = trendSeries(store.home, r.id);
  if (!points || !points.length) return c.yellow("该会话没有日志，或没有每步用量（assistant/message）事件");
  if (opts.json) return JSON.stringify(points, null, 2);
  const outT = sum(points.map((p) => p.outputTokens));
  const inT = sum(points.map((p) => p.inputTokens));
  const cacheT = sum(points.map((p) => p.cacheReadTokens));
  const peak = Math.max(...points.map((p) => p.outputTokens));
  const out = [];
  out.push(c.bold(`会话 ${shortId(r.id)} · 每步 token 用量（${points.length} 步）`));
  out.push("");
  out.push(
    "  输出合计 " + humanNum(outT) +
      " · 输入合计 " + humanNum(inT) +
      " · 缓存读取 " + humanNum(cacheT) +
      " · 峰值单步 " + humanNum(peak)
  );
  out.push("");
  out.push("  输出/步  " + c.cyan(sparkline(points.map((p) => p.outputTokens))));
  out.push("  输入/步  " + c.green(sparkline(points.map((p) => p.inputTokens))));
  out.push("");
  out.push(c.dim("  ▁=低 · █=高（按步归一化）"));
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// 命令分发
// ---------------------------------------------------------------------------

export function helpText() {
  return `DeepSeek Harness 管理终端 —— 借鉴 Codex 与 Claude Code 的会话/状态/用量管理
（本工具 dshm 是「管理看板」，只读 harness 数据；跟 AI 对话请用原生 dsh web → ${WEB_URL()}）

用法:
  dshm [命令] [参数] [选项]

命令:
  status              仪表盘：工作区 / 会话 / 目标 / 用量概览      (Claude /status)
  top                 实时刷新的状态面板（Ctrl+C 退出）
  web, ui             启动本地网页管理界面（默认 http://127.0.0.1:8787）
  ls, sessions        列出全部会话（可按 --all 含归档）            (Codex resume 列表)
  show <id>           查看某个会话的完整元数据                     (Claude /usage)
  usage               全局 token 与上下文用量汇总                  (Claude /cost)
  workspaces          列出工作区
  goal                显示当前活跃目标
  resume [id]         恢复会话：无 id 时列出候选                    (Codex resume)
  archive <id...>     归档会话（可多个 id，批量）
  unarchive <id...>   取消归档会话（可多个）
  export [id...]      导出可读 Markdown/JSON 会话记录（--all 全部）   【GUI 缺】
  backup              无损备份：复制原始会话日志 + 元数据            【GUI 缺】
  search <词>         跨工作区/会话全文搜索                          【GUI 缺】
  trend <id>          每步 token 用量趋势图                         【GUI 缺】
  help                显示本帮助

选项:
  --home <path>       指定 DSH 主目录（默认 $DSH_HOME 或 ~/.dsh）
  --json              以 JSON 输出（status/ls/show/usage/workspaces/goal/search/trend）
  --all               列出会话时包含已归档；export 时导出全部
  --format <md|json>  export 输出格式（默认 md）
  --out <目录>        export / backup 输出目录
  --limit <n>         search 最大命中数（默认 20）
  --reasoning         search 时也搜索推理内容
  --open              resume/web 时尝试在浏览器打开界面
  --host <addr>       web 绑定地址（默认 127.0.0.1）
  --port <端口>       web 监听端口（默认 8787）
  --watch <秒>        top 刷新间隔（默认 2 秒）
  --no-color          禁用颜色
  -h, --help          帮助
  -V, --version       版本

不带命令时进入交互式管理终端。
`;
}

export function runCommand(home, tokens, opts) {
  const [cmd, ...args] = tokens;
  const store = loadStore(home);
  switch (cmd) {
    case "status":
      return cmdStatus(store, opts);
    case "top":
      return { top: true };
    case "ls":
    case "sessions":
      return cmdList(store, opts);
    case "show":
      return cmdShow(store, args[0], opts);
    case "usage":
      return cmdUsage(store, opts);
    case "workspaces":
      return cmdWorkspaces(store, opts);
    case "goal":
      return cmdGoal(store, opts);
    case "resume":
      return cmdResume(store, args[0], opts);
    case "archive":
      return cmdArchive(store, args, opts);
    case "unarchive":
      return cmdUnarchive(store, args, opts);
    case "export":
      return cmdExport(store, args, opts);
    case "backup":
      return cmdBackup(store, args, opts);
    case "search":
      return cmdSearch(store, args, opts);
    case "trend":
      return cmdTrend(store, args[0], opts);
    case "web":
    case "ui":
    case "serve":
      return { web: { host: opts.host, port: opts.port, open: opts.open } };
    case "help":
    case "--help":
    case "-h":
      return helpText();
    default:
      throw new Error(`未知命令：${cmd ?? "(空)"}\n\n${helpText()}`);
  }
}
