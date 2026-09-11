import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";

/**
 * 判断一个 DSH 主目录是否「有实际数据」：有已注册工作区，或会话目录下有会话。
 */
export function isPopulatedHome(home) {
  const ws = join(home, "storages", "workspace.json");
  if (existsSync(ws)) {
    try {
      const raw = JSON.parse(readFileSync(ws, "utf8"));
      const tables = raw && raw.tables && raw.tables.workspaces;
      if (tables && Object.keys(tables).length > 0) return true;
    } catch {
      /* ignore */
    }
  }
  const sessions = join(home, "sessions");
  if (existsSync(sessions)) {
    try {
      return readdirSync(sessions).some((name) => name.startsWith("--") || /^[0-9a-f-]{8,}/i.test(name));
    } catch {
      /* ignore */
    }
  }
  return false;
}

/**
 * 解析 DeepSeek Harness 单根主目录，优先级：
 *   显式 `--home` > `$DSH_HOME` > 当前主线布局 `~/.toa3/harness-runtime/.dsh`（有数据）
 *   > 有数据的 `~/.dsh` > 扫描 `~/WorkBuddy/<时间戳>/.dsh` 取最新有数据者 > `~/.dsh`。
 * 返回 { home, source }，source 说明来源（flag/env/toa3/default/workbuddy）。
 *
 * 为什么把 `.toa3/harness-runtime/.dsh` 排在 WorkBuddy 前面：
 * 旧的 WorkBuddy 实例（3081，已退役删除）曾长期抢在主线前面被自动选中，
 * 导致 dshm 显示的是另一个实例的旧数据，看起来像"工具坏了"。
 */
export function resolveHome(env = process.env, opts = {}) {
  if (opts.home) return { home: opts.home, source: "flag" };
  if (env.DSH_HOME) return { home: env.DSH_HOME, source: "env" };

  const toa3 = join(homedir(), ".toa3", "harness-runtime", ".dsh");
  if (isPopulatedHome(toa3)) return { home: toa3, source: "toa3" };

  const def = join(homedir(), ".dsh");
  if (isPopulatedHome(def)) return { home: def, source: "default" };

  const wb = join(homedir(), "WorkBuddy");
  try {
    const candidates = readdirSync(wb, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => join(wb, d.name, ".dsh"))
      .filter((h) => existsSync(h) && isPopulatedHome(h));
    candidates.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    if (candidates.length) return { home: candidates[0], source: "workbuddy" };
  } catch {
    /* ignore */
  }
  return { home: def, source: "default" };
}
