import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// 只读地消费 Harness 落盘数据：workspace.json（工作区注册表 / 归档）、
// session_projcache.json（会话投影缓存：标题、统计、token、上下文、权限、目标）、
// settings.yaml（最小 YAML 子集，仅用于展示默认模型）。
// ---------------------------------------------------------------------------

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function readText(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

// ---- 最小 YAML（safe subset，用于 settings.yaml 的缩进 map + 标量） ----
function coerceScalar(v) {
  if (v === "true") return true;
  if (v === "false") return false;
  if (v === "null" || v === "~") return null;
  if (/^-?\d+$/.test(v)) return Number(v);
  if (/^-?\d+\.\d+$/.test(v)) return Number(v);
  if (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    return v.slice(1, -1);
  }
  return v;
}

function parseSimpleYaml(text) {
  if (!text) return {};
  const root = {};
  const stack = [{ indent: -1, obj: root }];
  for (const raw of text.split(/\r?\n/)) {
    const stripped = raw.replace(/#.*$/, "").trimEnd();
    if (!stripped.trim()) continue;
    const indent = stripped.length - stripped.trimStart().length;
    const content = stripped.trim();
    const m = content.match(/^([^:]+):(?:\s*(.*))?$/);
    if (!m) continue;
    const key = m[1].trim();
    const val = m[2] == null ? "" : m[2].trim();
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
    const parent = stack[stack.length - 1].obj;
    if (val === "") {
      const child = {};
      parent[key] = child;
      stack.push({ indent, obj: child });
    } else {
      parent[key] = coerceScalar(val);
    }
  }
  return root;
}

// ---- 路径 ----
export function workspacePaths(home) {
  return {
    workspace: join(home, "storages", "workspace.json"),
    cache: join(home, "storages", "session_projcache.json"),
    settings: join(home, "settings.yaml"),
  };
}

export function normPath(p) {
  return (p ?? "").replace(/[\\/]+$/, "").toLowerCase();
}

// ---- 载入 ----
export function loadWorkspace(home) {
  const raw = readJson(workspacePaths(home).workspace);
  const global = raw && typeof raw === "object" ? raw.global ?? {} : {};
  const archivedSet = new Set(
    Array.isArray(global.archivedSessionIds) ? global.archivedSessionIds : []
  );
  const tables = (raw && raw.tables && raw.tables.workspaces) || {};
  const order = Array.isArray(global.workspaceIds) ? global.workspaceIds : Object.keys(tables);
  const workspaces = [];
  const workspaceById = new Map();
  const push = (id, w) => {
    if (!w || workspaceById.has(id)) return;
    const rec = {
      id,
      path: w.path ?? null,
      title: w.title ?? null,
      sessionIds: Array.isArray(w.sessionIds) ? w.sessionIds : [],
      createdAt: w.createdAt ?? null,
      updatedAt: w.updatedAt ?? null,
    };
    workspaces.push(rec);
    workspaceById.set(id, rec);
  };
  for (const id of order) push(id, tables[id]);
  for (const id of Object.keys(tables)) push(id, tables[id]); // 防御：顺序里漏掉的条目
  return { workspaces, workspaceById, archivedSet };
}

function normSession(id, entry) {
  const rows = entry && entry.rows ? entry.rows : {};
  const v = (name) => (rows[name] ? rows[name].val ?? null : null);
  const stats = v("sessionStats") ?? {};
  const tu = v("tokenUsage") ?? {};
  const totals = tu.totals ?? {};
  const cp = v("contextPressure") ?? {};
  const meta = v("sessionListMetadata") ?? {};
  const used = cp.surfaceTokens ?? cp.pressureTokens ?? null;
  const win = cp.contextWindow ?? null;
  return {
    id,
    createdAt: (entry && entry.identity && entry.identity.createdAt) || null,
    cwd: (entry && entry.identity && entry.identity.cwd) || null,
    updatedAt: meta.lastPromptAt ?? ((entry && entry.identity && entry.identity.createdAt) || null),
    title: v("title") || null,
    goal: v("goal"),
    stats,
    turns: stats.turns ?? null,
    steps: stats.steps ?? null,
    llmMs: stats.llmMs ?? null,
    toolMs: stats.toolMs ?? null,
    ttftMs: stats.ttftMs ?? null,
    decodeMs: stats.decodeMs ?? null,
    decodeTokens: stats.decodeTokens ?? null,
    tokenUsage: tu,
    inputTokens: totals.uncachedInputTokens ?? null,
    outputTokens: totals.outputTokens ?? null,
    cacheReadTokens: totals.cacheReadTokens ?? null,
    cacheWriteTokens: totals.cacheWriteTokens ?? null,
    contextPressure: cp,
    contextUsed: used,
    contextWindow: win,
    contextPct: used != null && win ? (used / win) * 100 : null,
    contextBreakdown: v("contextBreakdown"),
    permissions: v("permissions"),
    todos: v("todos"),
    plan: v("plan"),
    subagent: v("subagent"),
    metadata: meta,
    wsId: null,
    wsTitle: null,
    archived: false,
  };
}

export function loadSessionCache(home) {
  const raw = readJson(workspacePaths(home).cache);
  const tables = (raw && raw.tables && raw.tables.sessions) || {};
  const sessions = new Map();
  for (const [id, entry] of Object.entries(tables)) {
    sessions.set(id, normSession(id, entry));
  }
  return sessions;
}

export function loadSettings(home) {
  return parseSimpleYaml(readText(workspacePaths(home).settings));
}

/**
 * 汇总成统一视图：会话按工作区分组（优先 workspace.sessionIds，其次 cwd 匹配），
 * 剩余为「未分组」。会话按最近活动倒序。
 */
export function loadStore(home) {
  const { workspaces, workspaceById, archivedSet } = loadWorkspace(home);
  const sessionsById = loadSessionCache(home);
  const settings = loadSettings(home);

  const wsIdBySession = new Map();
  for (const ws of workspaces) {
    for (const sid of ws.sessionIds) {
      if (!wsIdBySession.has(sid)) wsIdBySession.set(sid, ws.id);
    }
  }
  const wsIdByPath = new Map();
  for (const ws of workspaces) {
    if (ws.path) wsIdByPath.set(normPath(ws.path), ws.id);
  }

  const sessions = [];
  for (const [id, s] of sessionsById) {
    let wsId = wsIdBySession.get(id) ?? null;
    if (!wsId && s.cwd) wsId = wsIdByPath.get(normPath(s.cwd)) ?? null;
    s.wsId = wsId;
    s.wsTitle = wsId ? workspaceById.get(wsId)?.title ?? null : null;
    s.archived = archivedSet.has(id);
    sessions.push(s);
  }
  sessions.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));

  return {
    home,
    workspaces,
    workspaceById,
    archivedSet,
    sessions,
    sessionsById,
    settings,
  };
}

// ---- 归档 / 取消归档（原子写 workspace.json） ----
export function setSessionArchived(home, sessionId, archived) {
  const p = workspacePaths(home).workspace;
  const raw = readJson(p);
  if (!raw || typeof raw !== "object" || !raw.tables) {
    throw new Error("无法读取 workspace.json（Harness 工作区注册表不存在）");
  }
  raw.global = raw.global ?? {};
  const set = new Set(
    Array.isArray(raw.global.archivedSessionIds) ? raw.global.archivedSessionIds : []
  );
  if (archived) set.add(sessionId);
  else set.delete(sessionId);
  raw.global.archivedSessionIds = [...set];
  const tmp = `${p}.dshm-${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(raw, null, 2) + "\n", "utf8");
  renameSync(tmp, p);
  return set.size;
}
