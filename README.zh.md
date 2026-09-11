# dsh-plugin

中文 | [English](README.md)

DeepSeek Harness（DSH）Web GUI 的**插件家族**。三个插件共用同一套写法、同一套视觉语言和同一条安全基线，
看起来像一个产品，而不是三个互不相干的插件。

## 包

| 包 | 作用 | 入口 |
| --- | --- | --- |
| [`@chengchengzhao/dsh-cost-manager`](packages/cost-manager) | 余额、花费、消耗速率、模型价目对齐，以及「防死」硬地板。注册 4 个 Agent 可调用工具。 | 设置页面板 · `/cost` · `/board` |
| [`@chengchengzhao/dsh-session-manager`](packages/session-manager) | 会话浏览、跨会话全文搜索、每步 token 趋势、导出与归档。把原独立的 dshm 单页并入 DSH 端口。 | 设置页面板 · `/dshm` |
| [`@chengchengzhao/dsh-skill-catalog`](packages/skill-catalog) | 技能总览：每个技能是什么、怎么用、触发条件、边界、关联模型、验证级别。 | 设置页面板 · `/skills` · 运维看板页签 |

**运维看板**（`/board`，由 `cost-manager` 提供）是一条细页签栏 + 同源 iframe，三个看板因此共用一个浏览器标签。
切页签只切 `display`，iframe 不卸载、状态不丢。

```
/board#cost     费用与余额
/board#dshm     会话管理
/board#skills   技能总览
```

## 快速开始

```bash
# 在 DSH profile 目录下执行
dsh plugin --profile web add @chengchengzhao/dsh-cost-manager
dsh plugin --profile web add @chengchengzhao/dsh-session-manager
dsh plugin --profile web add @chengchengzhao/dsh-skill-catalog
```

改动 profile 的 `bundles` **必须重启 DSH** —— bundles 是启动时组装的，
`patchReload: "live"` 只对 `cordis.patch.yml` 的热更新生效。
重启后**记得强刷浏览器**（`Ctrl+Shift+R`）：停在旧连接的页面会一直重试旧 WebSocket，新插件不会出现。

用 `dsh --profile web --dump-config`（退出码 0）确认组合成功。

## 共用约定

这些是**契约**，不是偏好 —— 每个包的测试都会守着。

### 客户端 bundle

DSH 客户端插件必须是 `window.__ModuleLoader__.load({ id, factory })` 且为**纯 JavaScript**：
禁止 `import`、禁止 TypeScript、禁止 JSX。React 由 `require('react')` 注入，元素用 `React.createElement` 构造。

违反任一条会**静默失败** —— 插件在宿主侧是加载的，界面却什么也不出现。
各包的 `test-client.mjs` 就是守这个的。

### 注册方式

面板一律走官方 slots（`slots.inject('settings.section', …)`），**不直接操作 DOM**。
基于 DOM 的侧边栏注入一旦类名变动就会失效。

三个面板在设置页占用相邻的 order：

```
cost-manager 45  →  session-manager 46  →  skill-catalog 47
```

刻意避开 `order: 40` —— `dshmarket` 与 `dsh-vision-router` 已占用 40，平级后顺序由注册先后决定，
会把三个面板打散。

### 视觉语言

三个看板页共用同一套设计令牌 —— **包括变量名**、同一套页头结构、同一套内容词汇：

```css
:root {
  --bg:#0f1115; --panel:#161a22; --panel2:#1c212c; --border:#2a3140;
  --text:#e6e9ef; --muted:#8b93a5;
  --accent:#5b8cff; --green:#3ecf8e; --yellow:#f5c542; --red:#f26d6d;
  --radius:10px;
}
```

- 页头：`.brand`（含 `<span>` 副标题）+ `.toolbar`，`padding:14px 22px`、
  `background:var(--panel)`、sticky。toolbar 里带兄弟页交叉链接、**打开 Web GUI ↗**、
  自动刷新开关与刷新按钮 —— 所以没有哪一页是死胡同。
- 内容区：`main { max-width:1180px; margin:0 auto; padding:20px 22px 60px }`，
  统计用 `.cards/.card`。
- `/board` **不渲染自己的页头**（测试有断言）—— 页面身份交给被嵌入页面，否则会出现重复头。

**令牌名的统一和值的统一同样重要**：它决定了样式改动能在三页之间**复制**，而不是重写三遍。

设置面板很窄（约 500–700px），所以面板里的列表用**自适应卡片**，而整页在 1180px 下用表格。
卡片几何（圆角 10、内距 `9px 12px`、间距 8、次级文字 12px/`--muted`）在各面板间完全一致，且有测试断言。

## 安全

插件路由（`ctx.webServer.register`）**不在 DSH 外壳的鉴权门后面**。实测：`GET /` 返回 401，
而 `GET /skills` 返回 200。因此每个包都带 `lib/loopback.js`，所有路由都过它。

它**同时**校验 socket 远端地址与 `Host` 头，只查一个都不够：

- 只查远端地址 → **DNS rebinding** 照样成立（这类请求确实来自本机）；
- 只查 `Host` → 绑定到局域网时，真实远程连接仍能进来。

| 请求 | 结果 |
| --- | --- |
| `127.0.0.1:3082`、`localhost:3082` | 200 |
| 伪造 `Host: evil.example.com` | **403** |
| 远端 `192.168.x.x` | **403** |

每个包各存一份 `lib/loopback.js` 是刻意的：DSH 插件必须自包含，不能用跨包相对导入。
**改动时必须三处同步。**

## 开发

每个包自包含，无运行时依赖。

```bash
cd packages/<name>
node test-smoke.mjs     # host 半区：路由、返回结构、loopback 围栏
node test-client.mjs    # client 半区：bundle 契约、卡片数值一致性
node sync-core.mjs      # 内联共享核心源码、剔除用户数据
npm pack --dry-run      # 复核包内容
```

`sync-core.mjs` **向上搜索**已知标记目录来定位源，而不是数 `../..` 层数 ——
这样包在仓库里挪位置也不会悄悄指错目录。可用 `DSH_WORKSPACE`、`DSH_TOOLS`、
`DSH_SKILL_CATALOG_DIR` 覆盖。

任何包都不携带用户数据：记账文件、本机阈值与运行时状态都不进包，由代码在运行时创建或回退默认值。

## License

Apache-2.0
