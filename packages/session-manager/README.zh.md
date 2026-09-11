# @dachengge/dsh-session-manager

DSH 会话管理插件：把原本独立的 **dshm** 网页（单独进程 + `127.0.0.1:8787`）**统一到 DSH 自身端口上**，
并在设置页提供一个「会话管理」面板，与 DSH GUI 融为一个界面。

## 提供什么

| 形态 | 位置 | 说明 |
|---|---|---|
| 设置页面板 | DSH → 设置 → **会话管理** | 概览卡片、会话表、全文搜索、详情（含每步 token 趋势图）、导出、归档 |
| 完整界面 | DSH 端口下的 **`/dshm`** | 原 dshm 单页应用（会话表格 / 搜索 / 详情抽屉 / 趋势图 / 导出），由 host 半区直接伺服，不再需要 8787 |

数据全部来自 `$DSH_HOME`（只读为主）：

| 文件 | 用途 |
|---|---|
| `storages/workspace.json` | 工作区注册表、会话分组、归档集合 |
| `storages/session_projcache.json` | 会话投影：标题、统计、token、上下文、权限、目标、待办 |
| `settings.yaml` | 默认模型等设置 |
| `sessions/*/session.jsonl.zstd` | 会话日志（全文搜索 / 趋势 / 导出） |

唯一的**写**操作：`archive` / `unarchive`（原子替换 `workspace.json`，保留其余字段）。
建议在 GUI 空闲时归档，避免与正在运行的 Web GUI 竞争写入。

## 注册的路由

都挂在 DSH 自己的端口下（默认 `http://127.0.0.1:3082`）：

```text
GET  /dshm                                完整界面（原 8787 那份单页）
GET  /dshm/api/overview                   概览 + 会话表 + 工作区表
GET  /dshm/api/session?id=<id|前缀>        单个会话详情
GET  /dshm/api/search?q=&all=&reasoning=   跨会话全文搜索（默认不含归档、不搜推理）
GET  /dshm/api/trend?id=<id>               每步 token 用量序列
GET  /dshm/api/export?id=&format=md|json   导出可读会话记录
POST /dshm/api/archive?id=&archived=true|false
```

## 安装

```bash
# 本地开发（link 到工作区里的源码）
dsh plugin --profile web add link:C:/Users/43594/Desktop/harness中心/工具/dshm-plugin
# 改完代码后同步核心并重启 DSH 生效
node 工具/dshm-plugin/sync-core.mjs
```

发布到市场前先跑 `node sync-core.mjs`（把 `../../dshm/lib` 的核心内联进 `lib/core`，保证包自包含），
再 `npm pack --dry-run` 复核、`npm publish --access public`。

## 目录结构

```text
dshm-plugin/
├─ lib/index.js        host 半区：路由 + 完整界面伺服（/api/ → /dshm/api/ 改写）
├─ lib/client.js       浏览器半区：设置页「会话管理」面板
├─ lib/core/           内联的 dshm 核心（sync-core.mjs 生成，勿手改）
│   ├─ home.js         主目录解析（--home > DSH_HOME > ~/.toa3 > ~/.dsh > WorkBuddy）
│   ├─ store.js        读 workspace / projcache / settings 并归一化
│   ├─ logs.js         会话日志读取（异步并发解压 + mtime 增量 + transcript 缓存）
│   ├─ commands.js     会话/状态/用法等派生逻辑 + Markdown 渲染
│   ├─ format.js       ANSI 颜色 + CJK 宽度排版（CLI 侧复用）
│   └─ web/index.html  完整界面单页
├─ sync-core.mjs       从 ../../dshm/lib 同步核心
├─ test-smoke.mjs      host 半区冒烟（mock ctx，覆盖 8 条路由）
├─ test-client.mjs     客户端半区冒烟（mock React + slot 注册）
└─ dsh.plugin.json / cordis.patch.yml
```

## 性能说明

会话日志是「一个 header frame + 每批 append 一个 frame」的 zstd 帧拼接，实测 9 个会话共 **7.3 万帧**
（单个文件最多 6 万帧），且 Node 的 zstd **只解第一帧**，必须逐帧解。因此：

- 解压走 `promisify(zstdDecompress)` + 16 并发（串行 await 会被线程池往返拖到 2 倍耗时），
  **不阻塞 host 事件循环**——这是它能安全跑在 DSH 进程内的前提；
- 结果按「文件 mtime+size」缓存成 transcript + trend，重复请求 0ms；
- 会话 id → 日志路径做成一次遍历的索引，避免每个会话重走目录树。

实测（9 会话 / 7.3 万帧）：搜索冷启动 ~2.6s、热 **6ms**；趋势冷 ~3.0s、热 **7ms**；
5 个并发搜索合计 **29ms**（旧同步实现为 11.5s，且会把整个服务堵住）。
