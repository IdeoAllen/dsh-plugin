# @chengge/dsh-cost-manager

[中文](README.zh.md) | English

A cost-management plugin for the DeepSeek Harness (DSH): balances, spend, model
capabilities and per-session usage handed to the agent as callable tools, plus a
built-in **anti-death** mechanism (hard balance floor + switch recommendations).

## Four tools

| Tool | Purpose |
| --- | --- |
| `cost_status` | Per-platform balance and status, hard-floor warning, switch advice |
| `cost_stats` | Session token usage (by model / task / day, filterable by time and keyword) |
| `cost_report` | Recent spend ledger (image/video/avatar line items, aggregated by platform) |
| `cost_models` | Reads the user's **bound models** and aligns them with the price table (unit price / source / best-fit scenes) |

## Adapting to user configuration

- Reads the user's **bound models** via `ctx.llm.listProviders()` / `listModels()`
  and aligns prices against what is actually bound — no hard-coded model assumptions.
- Session usage comes from local DSH session files (`session.jsonl.zstd`),
  aggregated by the user's own tasks and sessions.

## UI: a Settings panel plus live dashboard pages on the DSH port

This is a **dual-half** plugin (host + client):

| Half | File | Responsibility |
| --- | --- | --- |
| Host | `lib/index.js` | Registers the 4 tools; `inject: ['tools','llm','webServer']`; registers JSON and page routes |
| Host | `lib/page.js` | The live dashboard served at `GET /cost` (self-contained HTML, replacing the old standalone `cost.mjs serve` process) |
| Host | `lib/board.js` | `GET /board` — the ops board: several tabs over same-origin iframes |
| Client | `lib/client.js` | Browser half; registers into `settings.section` (cost panel) and `sidebar.footer.action` (the sidebar "ops board" button) |

Routes (all on the DSH port, 3082 by default):

```text
GET /dsh-cost/api/overview    balances / burn rate / usage / two ledgers (?force=1 bypasses cache)
GET /cost  ·  /cost/          live dashboard (the old 8899 page, now folded into the DSH port)
GET /board ·  /board/         ops board: Cost / Sessions / Skills in one browser tab
```

**Multi-tab board**: `/board` iframes `/cost`, `/dshm` and `/skills` (same origin,
none sets `X-Frame-Options` or a blocking CSP). Switching tabs only toggles
`display`, so **iframes stay mounted and keep auto-refreshing**, and their view
state survives. The active tab is remembered in `localStorage` and `#cost` /
`#dshm` / `#skills` deep-link to it. On load it `HEAD`-pre-flights every URL and
marks the tab with a red dot if a page is not ready — instead of showing a blank
frame. The sidebar entry opens `/board` in a new tab.

Note the board depends on the plugins being present together: `/cost` comes from
this plugin, `/dshm` from `@chengge/dsh-session-manager`, `/skills` from
`@chengge/dsh-skill-catalog`.

**Layout rule: `/board` renders no header of its own.** It only draws a thin tab
strip (`.tabstrip` — deliberately not called `header`, and with a reduced font
size); page identity belongs to each embedded page. Otherwise you get a doubled
header. `test-smoke.mjs` asserts this: the `/board` HTML must contain **zero**
`<header>` elements and no `class="brand"`.

- The client bundle uses the DSH convention `window.__ModuleLoader__.load({ id, factory })`
  as **plain JavaScript with `React.createElement`** (no `import`, no TS, no JSX);
  React is injected by the module loader.
- **Visual contract**: `lib/page.js` shares its design tokens and header structure
  with the other `@chengge` pages — the same `:root` variables
  (`--bg/--panel/--border/--text/--muted/--accent/--green/--yellow/--red/--radius`),
  the same `<header>` shape (brand + subtitle + toolbar), and the same
  `.cards/.card/.panel/.foot` vocabulary. Align style changes across all three
  pages rather than letting one drift.
- Data path: the host exposes JSON/HTML via `ctx.webServer.register({ kind:'exact', path, handler })`;
  the client `fetch`es it.
- Panel content: burn rate (¥/h plus time-to-hard-floor, red under 2 hours),
  per-platform balances (coloured below alert/floor), the **two ledgers**
  (A = estimated, B = actually paid, plus unbilled cost — different bases, never
  add them together), and ledger B by platform.
- Performance: each balance probe has a 6s timeout (`COST_CHECK_TIMEOUT_MS`) and
  results are cached 45s; session scanning is async with mtime deltas and a 30s
  cache, so it **never blocks the host event loop**. The panel echoes last-known
  data from `localStorage` so it renders instantly, then refreshes.
- Ledger B lookup order: `COST_LEDGER` env var → bundled `lib/core/data/ledger.jsonl`
  → local dev layout `../../ledger.jsonl`. **No ledger data ships in the package.**
- If the panel does not appear after install, a hard refresh of the Web UI is enough.

### Security: loopback-only

Plugin routes registered through `ctx.webServer.register` are **not behind the DSH
web-auth gate** (measured: `GET /` returns 401 while plugin routes return 200).
All routes here run through `lib/loopback.js`, which validates **both** the socket
peer address and the `Host` header — the peer check alone cannot stop DNS rebinding
(such requests genuinely originate from localhost), and the `Host` check alone
cannot stop a real remote connection. Forged-`Host` and non-loopback-peer requests
get **403**.

## Packaging notes

- Core modules are inlined under `lib/core/` (balances / sessions / pricing /
  catalog), so the published package is self-contained with no out-of-package
  relative dependencies.
- Both halves are wired: `dsh.plugin.json` declares `client.main` and
  `package.json` exports `./client`.
- **No user data ships**: `ledger.jsonl` (real spend records) and `config.json`
  (local thresholds) are excluded; the code creates them or falls back to defaults
  at runtime. `sync-core.mjs` strips them.
- `node sync-core.mjs` copies the CLI-side sources into `lib/core/` while removing
  user data, preventing the two copies from drifting.

## Tests

```bash
node test-smoke.mjs     # host half: 4 tools, UI routes, response shapes, ledger B
node test-client.mjs    # client half: bundle load, slot registration, render
```

## Publishing

`dsh plugin --profile web <args>` forwards to pnpm, so "publishing to the market"
means publishing to the npm registry:

```bash
npm login                          # requires an npm account
cd dsh-plugin
node sync-core.mjs                 # inline core, strip user data
npm pack --dry-run                 # review package contents
npm publish --access public
```

Prerequisites: LICENSE = **Apache-2.0** (full text included), an npm login, and a
real install-and-restart check in a profile.

## Price table coverage

31 models/tools. Bound models aligned so far: `deepseek-v4-pro` (measured),
`deepseek-v4-flash-vision-exp` (estimated), `kimi-k2.6` / `glm-5.2` (registered,
unit price pending — the former awaits balance-delta calibration, the latter is a
coding subscription that does not bill per token).

## License

Apache-2.0
