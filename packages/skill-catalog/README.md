# @chengge/dsh-skill-catalog

[中文](README.zh.md) | English

A **skill catalog** for the DeepSeek Harness (DSH) Web GUI. Third plugin in the
`@chengge/dsh-*` family, alongside `@chengge/dsh-cost-manager` (cost & balance) and
`@chengge/dsh-session-manager` (session management) — same authoring conventions,
same visual language.

## Where it appears

| Entry point | Notes |
| --- | --- |
| **Ops board → skills tab** | `/board#skills`. The ops board (provided by `cost-manager`) is one thin tab strip over iframes: **Cost / Sessions / Skills**. Switching tabs only toggles `display`, so iframes stay mounted and keep auto-refreshing. |
| **Settings → skill catalog** | In-GUI panel that follows the DSH theme (light/dark). Uses an **adaptive card list**, not a wide table. |
| **`/skills`** | Standalone full-page dashboard, sharing the dark design tokens with the other two boards. |

The three `@chengge` panels sit together in Settings, in the order
**cost (45) → sessions (46) → skills (47)**.

> This plugin deliberately takes **no sidebar entry** of its own — the sidebar's
> "ops board" button already reaches the skills tab. Keeping a second bare link
> next to a button looked inconsistent.

### Adding a tab

Edit the `TABS` array at the top of `cost-manager`'s `lib/board.js`. The tab strip,
iframes, readiness pre-flight, `localStorage` memory and `#hash` deep links are all
driven by that one array.

## What it shows

- **Identity** — skill name, category, source (self-built / upstream)
- **Purpose** — the parsed description
- **How to use** — heading outline plus a body preview (truncated at 2600 chars)
- **Trigger conditions** — trigger-word chips
- **When not to use** — the boundary clause
- **Related models** — models detected in the skill body, with a usage note
- **Verification level** — V0/V1/V2/V3 plus the recorded evidence
- **Metrics** — body length, description length, whether it exceeds the catalog
  injection limit, missing dependencies

## Key design decisions

### Live data, not a snapshot

The host half **recomputes on every request**: it scans `~/.agents/skills/*/SKILL.md`
and optionally merges a `registry.json` for the verification fields.

**Edit a skill and a page refresh shows it** — there is no stale build artifact.
If no registry is found the plugin still works; it just omits verification levels
and says so in the UI.

### "No trigger words" does not mean "never invoked"

DSH has **no trigger-word mechanism**. It injects each skill's `name + description`
into context and lets the model decide semantically. Trigger words are merely
example phrasings written into the description. The panel states this explicitly
for skills that lack them.

### Description length discipline

DSH truncates injected descriptions at **500 characters** (cut to the first 497 +
`...`). `stats.truncated` and `stats.boundaryAtRisk` surface how many skills exceed
that — a boundary clause placed after character 497 is invisible to the model,
which makes it dead weight.

## Routes (on the DSH port)

```text
GET /skills                     full dashboard page
GET /skills/api/catalog         live skill catalog (JSON)
GET /skills/api/skill?name=     one skill's detail
GET /skills/api/health          self-check (count / registry / page readiness)
```

### Security: loopback-only

Plugin routes registered through `ctx.webServer.register` are **not behind the DSH
web-auth gate** (measured: `GET /` returns 401 while `GET /skills` returns 200).
Every route here therefore runs through `lib/loopback.js`, which validates **both**
the socket peer address and the `Host` header. One without the other is not enough:
the peer check alone cannot stop DNS rebinding (such requests genuinely originate
from localhost), and the `Host` check alone cannot stop a real remote connection.

| Request | Result |
| --- | --- |
| `127.0.0.1:3082`, `localhost:3082` | 200 |
| forged `Host: evil.example.com` | **403** |
| peer `192.168.x.x` | **403** |

## Install

In the profile's `package.json`:

```json
"dependencies": {
  "@chengge/dsh-skill-catalog": "link:<path-to>/dsh-plugin"
},
"dsh": { "profile": { "bundles": [ "...", "@chengge/dsh-skill-catalog" ] } }
```

`node_modules/@chengge/dsh-skill-catalog` must be a **junction** pointing at that
directory, matching the other `@chengge` plugins.

Changing `bundles` **requires a DSH restart** — the bundle list is composed at boot.
(`patchReload: "live"` only hot-reloads `cordis.patch.yml` changes.)

Verify with `dsh --profile web --dump-config` (exit code 0 means it composed).

## Tests

```bash
node test-smoke.mjs     # host half: catalog build, 4 routes, loopback fence
node test-client.mjs    # client half: bundle contract, shared card values
```

`test-client.mjs` guards the constraints whose violation makes a client plugin
**silently fail to mount**: no `import`, no JSX, `__ModuleLoader__` wrapper,
React via `require`, and registration through official slots rather than DOM edits.

## Maintenance

After editing the dashboard page, sync the artifact into the plugin:

```bash
node <tools>/skill-catalog/build-html.mjs            # regenerate the dashboard HTML
node <tools>/skill-catalog/dsh-plugin/sync-core.mjs  # copy it into lib/core/web
```

`sync-core.mjs` only copies the HTML; the host half rewrites `./catalog.json`
to `/skills/api/catalog`, so the page always reads live data. The page is **not
cached**, so an HTML change needs only a page refresh — no restart.

## Interop with `@linxin666/dsh-client-ui-skill-explorer`

Different layers, safe to run together — but one interaction matters.

| | This plugin | skill-explorer |
| --- | --- | --- |
| Layer | **Read-only display** | **Management** (enable/disable, create, delete) |
| Entry | Ops-board tab · Settings panel · `/skills` | Sidebar "skill center" |
| Writes | none | rewrites frontmatter / creates / moves to `.trash` |

### Toggling a skill invalidates its verification

skill-explorer's enable/disable rewrites the `disable-model-invocation` key in
`SKILL.md` — a real file change. The registry this plugin reads binds verification
to a **content hash**, so any edit automatically voids `V2 verified` back down to
`V0`, and the next scan reports "verification voided: body changed".

That is by design — a verification only ever applied to the body it was run
against. After using skill-explorer, re-align the registry:

```bash
node <tools>/skill-registry/refresh.mjs
```

### Telemetry

- This plugin: **no outbound requests** (enforced by a check in the registry's
  HTML verifier).
- skill-explorer: one anonymous install heartbeat per UTC day to `dsh-market.com`
  (a random localStorage id plus the package name).

## Known limits

- The Settings panel lists the first 150 skills (it points to the full board beyond that).
- Body previews are truncated at 2600 characters; see `SKILL.md` for the whole thing.
- Registry lookup order: `DSH_SKILL_REGISTRY` env var → plugin-relative paths →
  common workspace path.

## License

Apache-2.0
