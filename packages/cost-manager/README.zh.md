# @dachengge/dsh-cost-manager

DSH 成本管理插件：把余额、费用、模型能力、任务会话用量统计交给 Agent 自动调用，并内置「防死」机制（硬地板 + 欠费切换建议）。

## 提供 4 个工具

| 工具 | 作用 |
|---|---|
| `cost_status` | 各平台余额与状态 + 硬地板提示 + 切换建议 |
| `cost_stats` | 会话 token 用量统计（按 模型/任务/日，支持时间与关键词筛选） |
| `cost_report` | 最近花费账本（图片/视频/数字人等实付项，按平台聚合） |
| `cost_models` | 读用户「绑定的模型」并与价目表对齐（单价/来源/擅长场景） |

## 与用户配置的适配

- 通过 `ctx.llm.listProviders()/listModels()` 读取用户**绑定的模型**，按实际绑定做价目对齐，不做写死的模型假设。
- 会话用量来自本机 DSH 会话文件（`session.jsonl.zstd`），按用户自己的任务/会话聚合。

## UI：设置页「费用与余额」面板 + 3082 上的实时总览页

插件是**双半区**插件（host + client）：

| 半区 | 文件 | 职责 |
|---|---|---|
| Host | `lib/index.js` | 注册 4 个工具；`inject: ['tools','llm','webServer']`；注册 JSON 路由与页面路由 |
| Host | `lib/page.js` | `GET /cost` 的实时总览页（自包含 HTML，替代原先单独进程的 `cost.mjs serve`） |
| Host | `lib/board.js` | `GET /board` 运维看板：同一标签内两个页签，iframe 嵌 `/cost` 与 `/dshm` |
| Client | `lib/client.js` | 浏览器半区，注册到 `settings.section`（费用面板）与 `sidebar.footer.action`（侧栏「运维看板」入口） |

注册的路由（都挂在 DSH 自己的端口下，默认 3082）：

```text
GET /dsh-cost/api/overview    余额 / 速率 / 用量 / 两套账（?force=1 强制重测）
GET /cost  ·  /cost/          实时总览页（原 8899 那份，已并入 DSH 端口）
GET /board ·  /board/         运维看板：费用与余额 / 会话管理 两个页签合一
```

**多页签看板**说明：`/board` 用 iframe 嵌 `/cost` 与 `/dshm`（同源，均无 `X-Frame-Options`/CSP 限制），
切换页签只切 `display`——**iframe 不卸载，各自的自动刷新继续跑**，也不会丢当前视图状态。
页签选择记在 `localStorage`，也支持 `#cost` / `#dshm` 直达。打开时会 `HEAD` 预检两个地址，
哪一页没就绪（插件没装/没重启）就在该页签上标红点，而不是白屏。
侧栏底部由 `sidebar.footer.action` 提供「📊 运维看板」入口（新标签打开 `/board`）。
注意：看板依赖两个插件同时在位——`/cost` 来自本插件，`/dshm` 来自 `@dachengge/dsh-session-manager`。

**布局铁律：`/board` 不渲染自己的页头。** 它只有一条细页签栏（`.tabstrip`，不叫 `header`、
字号也刻意压小），页面身份交给被嵌入页面自己的页头。否则会出现"重复头"（看板一层 + iframe 内一层）。
`test-smoke.mjs` 为此加了回归断言：`/board` 的 HTML 里 `<header>` 数量必须为 **0**、且不得出现 `class="brand"`。

- 客户端 bundle 采用 DSH 约定格式 `window.__ModuleLoader__.load({ id, factory })`，**纯 JavaScript + `React.createElement`**（禁止 import / TS / JSX）；React 由模块加载器注入。
- **视觉规范**：`lib/page.js` 与 dshm 的 `/dshm` 页面共用同一套设计令牌与页头结构——同一组 `:root` 变量（`--bg/--panel/--border/--text/--muted/--accent/--green/--yellow/--red/--radius`）、同样的 `<header>` 结构（brand + 副标题 + toolbar、`padding:14px 22px`、`background:var(--panel)`、sticky）、同样的 `.cards/.card/.panel/.foot` 语法。改样式时请与 `dshm/lib/web/index.html` 对齐，不要单独漂移。
- 数据通路：host 用 `ctx.webServer.register({ kind:'exact', path, handler })` 暴露 JSON/HTML，client 用 `fetch` 取。
- 面板内容：消耗速率（¥/h + 距硬地板可撑时长，不足 2 小时标红）、各平台余额（低于预警/地板着色）、**两套账**（账 A 估费 / 账 B 实付 / 成本待补，口径不同勿相加）、账 B 按平台分布。
- 性能：单家余额探测 6s 超时（`COST_CHECK_TIMEOUT_MS` 可调）+ 45s 结果缓存；会话扫描走异步 + mtime 增量 + 30s 缓存，**不阻塞 host 事件循环**；面板用 localStorage 回显上次数据（打开即出内容，后台再刷新）。
- 账 B（实付记账）文件按优先级查找：`COST_LEDGER` 环境变量 → 包内 `lib/core/data/ledger.jsonl` → 本地开发布局 `../../ledger.jsonl`。包内不含账目数据。
- 安装后如未显示，硬刷新 Web UI 即可。

## 状态（内联完成，待真机验证）

- ✅ 核心已内联进 `lib/core/`（balances / sessions / pricing / catalog），发布后自包含、无包外相对路径依赖。
- ✅ 双半区齐全：`dsh.plugin.json` 声明 `client.main`，`package.json` 导出 `./client`。
- 🔒 **包内不含用户数据**：`ledger.jsonl`（真实记账明细）与 `config.json`（本机阈值设置）不进包，运行时由代码自动创建/回退默认值。`sync-core.mjs` 会主动剔除它们。
- 同步脚本：`node sync-core.mjs` 把 CLI 侧同源文件复制进 `lib/core/` 并剔除用户数据，防止两套代码漂移。
- 冒烟测试：`node test-smoke.mjs`（4 个工具 + UI 路由注册与返回结构，含账 B 汇总）、`node test-client.mjs`（客户端半区加载、slot 注册、组件渲染）。

## 如何上市场

`dsh plugin --profile web <args>` 实际转发给 pnpm，所以「上插件市场」= 发布到 npm registry：

```bash
npm login                 # 需 npm 账号（当前机器未登录）
cd dsh-plugin
node sync-core.mjs        # 内联核心 + 剔除用户数据
npm pack --dry-run        # 复核包内容
npm publish --access public
```

发布前置：① ✅ LICENSE = **Apache-2.0**（已附全文，含专利授权，保留署名）；② ⏳ npm 账号登录（`npm login`，当前机器未登录）；③ ⏳ 真机装进 profile 验证（`dsh plugin --profile web add @dachengge/dsh-cost-manager` + 重启）。

当前包内容（`npm pack --dry-run`）：11 个文件 / 26.1 kB —— LICENSE、README、cordis.patch.yml、dsh.plugin.json、package.json、lib/index.js、lib/client.js、lib/core/{balances,sessions,pricing}.mjs、lib/core/data/catalog.json。

> 本地校验：`node test-smoke.mjs`（host 半区）、`node test-client.mjs`（client 半区）。安装后硬刷新 Web UI 即可看到设置页面板。

## 价目表覆盖

- 31 个模型/工具。绑定模型已对齐：`deepseek-v4-pro`（实测）、`deepseek-v4-flash-vision-exp`（估算 5 元/1M token）、`kimi-k2.6` / `glm-5.2`（已登记，单价待测——前者待余额差法标定，后者为 coding 套餐不计 token 单价）。
