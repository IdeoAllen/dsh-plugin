# @dachengge/dsh-skill-catalog

DSH 第三个自定义插件 —— **技能总览**。与 `@dachengge/dsh-cost-manager`（费用与余额）、
`@dachengge/dsh-session-manager`（会话管理）出自同一套写法，界面与配色保持一致。

## 提供什么

| 入口 | 说明 |
| --- | --- |
| **运维看板 → 技能总览 页签** | `/board#skills`。运维看板由 cost-manager 提供，一条细页签栏 + iframe：**费用与余额 / 会话管理 / 技能总览**。切页签只切 display，iframe 不卸载，各页自动刷新继续跑。 |
| **设置页 → 技能总览** | 面板形式，嵌在 DSH GUI 里，跟随 DSH 主题（浅色/深色自动适配）。**自适应卡片列表**，不是多列表格。 |
| **`/skills`** | 完整看板（独立整页，与另两个看板的深色风格一致） |

三个插件在设置页的排列顺序：**费用与余额（45）→ 会话管理（46）→ 技能总览（47）**。

> 本插件**不单独占用侧边栏入口** —— 侧边栏「运维看板」按钮即可进入技能总览页签，
> 避免出现一个按钮 + 一个裸链接并排的样式不一致（上一版的问题）。

### 新增页签只改一处

`工具/cost-manager/dsh-plugin/lib/board.js` 顶部的 `TABS` 数组：

```js
const TABS = [
  { id: 'cost',   title: '费用与余额', url: '/cost',   hint: '…' },
  { id: 'dshm',   title: '会话管理',   url: '/dshm',   hint: '…' },
  { id: 'skills', title: '技能总览',   url: '/skills', hint: '…' },
]
```

页签栏、iframe、红点预检、localStorage 记忆、`#hash` 深链全部由这段配置驱动。

## 展示什么

- **是什么**：技能名 + 分类 + 来源（自建/上游）
- **干什么用**：解析后的用途描述
- **怎么用**：正文骨架（标题层级）+ 正文预览（截断到 2600 字符）
- **触发条件**：触发词 chip
- **什么时候别用**：边界声明
- **关联模型**：从正文识别的模型（附用途注释）
- **验证级别**：V0/V1/V2/V3 + 验证证据
- **指标**：正文长度、描述长度、是否超目录注入上限、缺失依赖

## 关键设计

### 数据实时，不是快照

host 半区**每次请求现算**：直接扫 `~/.agents/skills/*/SKILL.md`，
再尝试合并 `工具/skill-registry/registry.json` 补充验证字段。

**所以技能一改，刷新页面就是最新的**，不存在构建产物陈旧的问题。
注册表找不到也能正常工作，只是少了验证级别（界面会标注"未找到"）。

### 显示"无触发词"不代表不会被调用

DSH **没有触发词机制**——它把 `name + description` 注入上下文，由模型按语义判断是否加载。
触发词只是写在描述里的示例。面板里对没有触发词的技能会明确说明这一点。

### 描述长度纪律

DSH 注入的 description 上限 **500 字符**（超出截断为前 497 + `...`）。
`stats.truncated` / `stats.boundaryAtRisk` 会把超长和"边界会被截断"的技能数报出来 ——
边界声明若落在 497 之后，模型根本看不到，等于白写。

## 路由（挂在 DSH 自身端口上）

```
GET /skills                    完整看板页面
GET /skills/api/catalog        实时技能目录（JSON）
GET /skills/api/skill?name=    单个技能详情
GET /skills/api/health         自检（技能数/注册表/页面是否就绪）
```

## 安装

profile 的 `package.json`：

```json
"dependencies": {
  "@dachengge/dsh-skill-catalog": "link:C:/Users/43594/Desktop/harness中心/工具/skill-catalog/dsh-plugin"
},
"dsh": { "profile": { "bundles": [ "...", "@dachengge/dsh-skill-catalog" ] } }
```

`node_modules/@dachengge/dsh-skill-catalog` 需为 **Junction** 指向该目录（与另两个 `@dachengge` 插件同款）。

改完 **必须重启 DSH**：`bundles` 是启动时组装的，
`patchReload: "live"` 只对 `cordis.patch.yml` 的热更新生效。

校验：`dsh --profile web --dump-config`（退出码 0 即组合成功）。

## 维护

渲染器**随包一起发布**，所以仓库是自包含的 —— 重建看板不需要作者本机的工具目录：

```bash
node tools/build-html.mjs    # 渲染 技能总览.html
node tools/verify-html.mjs   # 静态校验（不需要浏览器）
node sync-core.mjs           # 复制进 lib/core/web/index.html
```

`tools/build-html.mjs` 按这个顺序找数据：

1. 设了 `DSH_SKILL_CATALOG_DIR` → 用那个目录（作者的开发工作区在那里放预生成的
   `catalog.json`，由 skill-registry 工具链产出，字段更全）；
2. 否则**回退到本包自己的 `lib/catalog.js`**，它现场扫 `~/.agents/skills`。
   不需要任何预生成数据文件，所以刚 clone 下来也能渲染成功 —— 只是技能数比装满的机器少。

`sync-core.mjs` 只复制 HTML；host 半区会把页面里的 `./catalog.json`
改写成 `/skills/api/catalog`，从而自动走真实时数据。页面**不缓存**，
所以改完 HTML 刷新页面即可，不用重启 DSH。

## 与社区插件 `@linxin666/dsh-client-ui-skill-explorer` 共存

两个插件**定位不同、可以并存**，但有一处会互相影响，必须知道。

| | 本插件（skill-catalog） | skill-explorer |
| --- | --- | --- |
| 定位 | **展示层**（是什么/怎么用/触发条件/关联模型/验证级别） | **管理层**（启用·禁用 / 创建 / 删除） |
| 入口 | 运维看板第三页签 · 设置页面板 · `/skills` | 侧边栏「技能中心」 |
| 写操作 | 无（只读） | 改写 frontmatter / 创建 / 移入 `.trash` |

### ⚠️ 启停会作废验证结论

skill-explorer 的「启用/禁用」是**改写 `SKILL.md` frontmatter 的
`disable-model-invocation`** —— 那是真实修改技能文件。

而本插件读的注册表用**内容哈希绑定验证结论**：文件一改，
`V2 已验证` 会自动作废并降回 `V0`，下次 `scan` 会显示
「验证作废：正文已变更」。

**这不是 bug，是设计如此**（验证只对当时那份正文有效）。操作建议：

```bash
# 用 skill-explorer 做过启停/创建/删除之后
node 工具/skill-registry/refresh.mjs
```

跑一次让注册表重新对齐即可。

### 遥测差异

- 本插件：**零外发请求**（`verify-html.mjs` 有校验项守着这条）
- skill-explorer：每个 UTC 日向 `dsh-market.com` 发一次匿名安装心跳
  （仅 localStorage 随机 ID + 包名）

## 已知边界

- 设置面板最多显示前 150 个技能（超出提示用完整看板）
- 正文预览截断到 2600 字符（完整内容看 `SKILL.md`）
- 注册表路径按：环境变量 `DSH_SKILL_REGISTRY` → 插件相对路径 → 常见工作区路径 依次探测
