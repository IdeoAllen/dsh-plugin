# dsh-plugin

[中文](README.zh.md) | English

A family of plugins for the **DeepSeek Harness (DSH)** Web GUI. They share one
authoring convention, one visual language and one security posture, so they read
as a single product rather than three unrelated add-ons.

## Packages

| Package | What it does | Entry points |
| --- | --- | --- |
| [`@chengge/dsh-cost-manager`](packages/cost-manager) | Balances, spend, burn rate, model price alignment and the anti-death floor. Registers 4 agent-callable tools. | Settings panel · `/cost` · `/board` |
| [`@chengge/dsh-session-manager`](packages/session-manager) | Session browsing, cross-session full-text search, per-step token trends, export and archive. Folds the standalone dshm app onto the DSH port. | Settings panel · `/dshm` |
| [`@chengge/dsh-skill-catalog`](packages/skill-catalog) | Skill catalog: what each skill is, how to use it, its trigger conditions, boundary, related models and verification level. | Settings panel · `/skills` · ops-board tab |

The **ops board** (`/board`, provided by `cost-manager`) is one thin tab strip over
same-origin iframes, so all three dashboards live in a single browser tab. Switching
tabs only toggles `display` — iframes stay mounted and keep their state.

```
/board#cost     balances and burn rate
/board#dshm     sessions
/board#skills   skill catalog
```

## Quick start

```bash
# from a DSH profile directory
dsh plugin --profile web add @chengge/dsh-cost-manager
dsh plugin --profile web add @chengge/dsh-session-manager
dsh plugin --profile web add @chengge/dsh-skill-catalog
```

Changing the profile's `bundles` list **requires a DSH restart** — bundles are
composed at boot, and `patchReload: "live"` only hot-reloads `cordis.patch.yml`
changes. After a restart, **hard-refresh the browser** (`Ctrl+Shift+R`); a stale
page keeps retrying its old WebSocket and newly added plugins will not appear.

Verify a profile composes with `dsh --profile web --dump-config` (exit code 0).

## Shared conventions

These are contracts, not preferences — each package's tests assert them.

### Client bundles

DSH client plugins must be `window.__ModuleLoader__.load({ id, factory })` with
**plain JavaScript**: no `import`, no TypeScript, no JSX. React arrives through
`require('react')` and elements are built with `React.createElement`.

Violating any of these makes a plugin **fail silently** — it stays loaded on the
host while nothing appears in the UI. `test-client.mjs` in each package guards
them.

### Registration

Panels register through the official slots (`slots.inject('settings.section', …)`),
never by manipulating the DOM. DOM-based sidebar injection breaks whenever a class
name changes.

The three panels occupy adjacent orders in Settings:

```
cost-manager 45  →  session-manager 46  →  skill-catalog 47
```

They deliberately avoid `order: 40`, which `dshmarket` and `dsh-vision-router`
already use — ties are broken by registration sequence, which scatters the panels.

### Visual language

All three dashboard pages share the same design tokens **including the variable
names**, the same page header structure and the same content vocabulary:

```css
:root {
  --bg:#0f1115; --panel:#161a22; --panel2:#1c212c; --border:#2a3140;
  --text:#e6e9ef; --muted:#8b93a5;
  --accent:#5b8cff; --green:#3ecf8e; --yellow:#f5c542; --red:#f26d6d;
  --radius:10px;
}
```

- Header: `.brand` (with a `<span>` subtitle) + `.toolbar`, `padding:14px 22px`,
  `background:var(--panel)`, sticky. The toolbar carries cross-links to the sibling
  pages, an **open Web GUI ↗** link, an auto-refresh toggle and a refresh button —
  so no page is a dead end.
- Content: `main { max-width:1180px; margin:0 auto; padding:20px 22px 60px }`,
  `.cards/.card` for statistics.
- `/board` renders **no header of its own** (asserted in tests) — page identity
  belongs to each embedded page, otherwise the header appears twice.

Sharing token *names* matters as much as sharing values: it is what lets a style
change be copied between the three pages instead of rewritten three times.

Settings panels are narrow (~500–700px), so lists there use an **adaptive card
layout** while the full pages use tables at 1180px. Card geometry (radius 10,
padding `9px 12px`, margin 8, secondary text 12px/`--muted`) is identical across
panels and asserted by tests.

## Security

Plugin routes registered through `ctx.webServer.register` are **not behind the DSH
web-auth gate**. Measured on a live instance: `GET /` returns 401 while
`GET /skills` returns 200. Every package therefore ships `lib/loopback.js` and runs
all routes through it.

It validates **both** the socket peer address and the `Host` header. Neither alone
is sufficient:

- peer address only → **DNS rebinding** still works, because such requests genuinely
  originate from localhost;
- `Host` only → a real remote connection on a LAN-bound instance still gets through.

| Request | Result |
| --- | --- |
| `127.0.0.1:3082`, `localhost:3082` | 200 |
| forged `Host: evil.example.com` | **403** |
| peer `192.168.x.x` | **403** |

Each package carries its own copy of `lib/loopback.js` on purpose: DSH plugins must
be self-contained and cannot use cross-package relative imports. **Change all three
together.**

## Development

Each package is self-contained and has no runtime dependencies.

```bash
cd packages/<name>
node test-smoke.mjs     # host half: routes, response shapes, loopback fence
node test-client.mjs    # client half: bundle contract, shared card values
node sync-core.mjs      # inline shared core sources, strip user data
npm pack --dry-run      # review package contents
```

`sync-core.mjs` resolves its source directory by **searching upward** for a known
marker rather than counting `../..` levels, so moving a package inside the repo
cannot silently point it at the wrong directory. `DSH_WORKSPACE`, `DSH_TOOLS` and
`DSH_SKILL_CATALOG_DIR` override the search.

No package ships user data. Ledger files, local thresholds and runtime state are
excluded from the tarball and recreated (or defaulted) at runtime.

## License

Apache-2.0
