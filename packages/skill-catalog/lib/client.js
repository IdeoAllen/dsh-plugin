// @chengge/dsh-skill-catalog — 浏览器半区（设置页「技能总览」面板）
//
// DSH 客户端插件 bundle 格式：window.__ModuleLoader__.load({ id, factory })。
// 必须是纯 JavaScript：禁止 import / TypeScript / JSX；React 由模块加载器注入。
// 数据来自 host 半区路由：/skills/api/catalog
//
// 风格与 dshm / cost-manager 保持一致：同一套 DSH 主题变量。
// 布局用**自适应卡片列表**而非多列表格——设置面板宽度通常在 500-700px，
// 6 列表格会被挤到每列只剩几个字（上一版的实际问题）。
window.__ModuleLoader__.load({
  id: '@chengge/dsh-skill-catalog',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')
    var h = React.createElement

    var API = '/skills/api/catalog'
    var FULL_PAGE = '/skills'
    var BOARD = '/board#skills'
    var CACHE_KEY = 'dsh-skill-catalog-v1'

    // 跟随 DSH 主题的 CSS 变量（带浅色兜底）——与另两个插件完全一致
    var INK = 'var(--dsw-alias-label-primary, #1f2328)'
    var INK2 = 'var(--dsw-alias-label-secondary, #6b7280)'
    var LINE = 'var(--dsw-alias-border-l2, #e5e7eb)'
    var CARD = 'var(--dsw-alias-bg-layer-2, #ffffff)'
    var WARN = '#c05621'
    var DANGER = '#c53030'
    var OK = '#2f855a'
    var ACCENT = '#3b82f6'

    var box = { background: CARD, border: '1px solid ' + LINE, borderRadius: 12, padding: '14px 16px', marginBottom: 12 }
    var cap = { fontSize: 12, color: INK2, letterSpacing: '.04em', marginBottom: 10, fontWeight: 700 }
    var row = { display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 12 }
    var mini = { flex: '1 1 104px', background: CARD, border: '1px solid ' + LINE, borderRadius: 12, padding: '10px 14px' }
    var miniLabel = { fontSize: 11.5, color: INK2, marginBottom: 4 }
    var miniValue = { fontSize: 19, fontWeight: 800, color: INK }
    var btn = {
      border: '1px solid ' + LINE, background: 'transparent', color: INK, borderRadius: 8,
      padding: '5px 10px', fontSize: 12.5, cursor: 'pointer', font: 'inherit',
    }
    var closeBtn = {
      border: '1px solid ' + LINE, background: 'transparent', color: INK2, borderRadius: 8,
      padding: '3px 11px', fontSize: 12.5, cursor: 'pointer', font: 'inherit', whiteSpace: 'nowrap',
    }
    var input = {
      border: '1px solid ' + LINE, background: 'transparent', color: INK, borderRadius: 8,
      padding: '6px 10px', fontSize: 12.5, font: 'inherit', outline: 'none', flex: '1 1 200px', minWidth: 0,
    }
    var chip = {
      display: 'inline-block', border: '1px solid ' + LINE, borderRadius: 5, padding: '0 5px',
      fontSize: 11, color: INK2, marginRight: 4, marginBottom: 3, whiteSpace: 'nowrap',
    }
    // ── 列表卡片约定：与 dshm / cost-manager 面板保持同一套数值 ──
    // 卡片外观：border/cardRadius/padding/marginBottom 三处必须一致，否则并排看得出差异。
    var item = {
      border: '1px solid ' + LINE, borderRadius: 10, padding: '9px 12px', marginBottom: 8,
      cursor: 'pointer', background: 'transparent',
    }
    var itemHead = { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }
    var itemName = { fontSize: 13, fontWeight: 700, color: ACCENT, wordBreak: 'break-all' }
    // 次级说明文字：统一 12px / INK2（dshm 的 itemMeta 同值）
    var itemPur = { fontSize: 12, color: INK2, lineHeight: 1.5, marginTop: 3 }
    var itemTrg = { marginTop: 5 }

    function readCache() {
      try {
        var raw = window.localStorage.getItem(CACHE_KEY)
        if (!raw) return null
        var j = JSON.parse(raw)
        return j && j.skills ? j : null
      } catch (e) { return null }
    }
    function writeCache(payload) {
      try { window.localStorage.setItem(CACHE_KEY, JSON.stringify(payload)) } catch (e) { /* 隐私模式静默 */ }
    }
    function levelColor(lv) {
      if (lv === 'V2' || lv === 'V3') return OK
      if (lv === 'V1') return ACCENT
      if (lv === 'V0') return WARN
      return INK2
    }
    function clip(s, n) {
      var t = String(s || '')
      return t.length > n ? t.slice(0, n) + '…' : t
    }

    function Panel() {
      var s0 = React.useState(readCache())
      var data = s0[0], setData = s0[1]
      var s1 = React.useState(false)
      var loading = s1[0], setLoading = s1[1]
      var s2 = React.useState(null)
      var err = s2[0], setErr = s2[1]
      var s3 = React.useState('')
      var q = s3[0], setQ = s3[1]
      var s4 = React.useState('')
      var cat = s4[0], setCat = s4[1]
      var s5 = React.useState(null)
      var open = s5[0], setOpen = s5[1]

      function load() {
        setLoading(true)
        fetch(API, { cache: 'no-store' })
          .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json() })
          .then(function (j) {
            if (j && j.error) throw new Error(j.error)
            setData(j); writeCache(j); setErr(null)
          })
          .catch(function (e) { setErr(String(e && e.message ? e.message : e)) })
          .then(function () { setLoading(false) })
      }
      React.useEffect(function () { load() }, [])

      // ESC 关闭详情
      React.useEffect(function () {
        function onKey(e) { if (e.key === 'Escape') setOpen(null) }
        window.addEventListener('keydown', onKey)
        return function () { window.removeEventListener('keydown', onKey) }
      }, [])

      var skills = (data && data.skills) || []
      var stats = (data && data.stats) || null

      var list = skills.filter(function (s) {
        if (cat && s.category !== cat) return false
        if (!q) return true
        var hay = (s.name + ' ' + s.purpose + ' ' + (s.triggers || []).join(' ') + ' ' + s.boundary + ' ' + s.category + ' ' + s.description).toLowerCase()
        return hay.indexOf(q.toLowerCase()) >= 0
      })

      var head = h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 10, flexWrap: 'wrap' } },
        h('div', { style: { fontSize: 16, fontWeight: 800, color: INK } }, '技能总览'),
        h('div', { style: { fontSize: 12, color: INK2 } }, skills.length ? (skills.length + ' 个技能') : ''),
        h('div', { style: { flex: 1 } }),
        h('button', { type: 'button', onClick: load, style: btn, disabled: loading }, loading ? '刷新中…' : '刷新'),
        h('a', { href: BOARD, target: '_blank', rel: 'noreferrer', style: Object.assign({}, btn, { textDecoration: 'none', display: 'inline-block' }) }, '运维看板 ↗'),
        h('a', { href: FULL_PAGE, target: '_blank', rel: 'noreferrer', style: Object.assign({}, btn, { textDecoration: 'none', display: 'inline-block' }) }, '独立页 ↗')
      )

      var errLine = err ? h('div', { style: { fontSize: 12, color: DANGER, marginBottom: 8 } }, '刷新失败：' + err + (data ? '（下面为上次数据）' : '')) : null

      var cards = stats ? h('div', { style: row },
        [['技能总数', stats.total], ['自建', stats.bySource['自建']], ['上游', stats.bySource['上游']],
         ['有触发词', stats.withTriggers], ['有边界声明', stats.withBoundary],
         ['V2 已验证', (stats.byLevel && stats.byLevel['V2']) || 0], ['超长截断', stats.truncated]]
          .map(function (p, i) {
            return h('div', { key: i, style: mini },
              h('div', { style: miniLabel }, p[0]),
              h('div', { style: miniValue }, String(p[1] == null ? '—' : p[1])))
          })
      ) : null

      var cats = stats ? Object.keys(stats.byCategory || {}).sort(function (a, b) { return stats.byCategory[b] - stats.byCategory[a] }) : []
      var filterBar = h('div', { style: { display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' } },
        h('input', { type: 'search', value: q, placeholder: '搜索：名称 / 用途 / 触发词 / 分类 …', style: input, onChange: function (e) { setQ(e.target.value) } }),
        h('select', { value: cat, style: Object.assign({}, input, { flex: '0 0 auto', width: 170 }), onChange: function (e) { setCat(e.target.value) } },
          [h('option', { key: '', value: '' }, '全部分类')].concat(cats.map(function (c) {
            return h('option', { key: c, value: c }, c + '（' + stats.byCategory[c] + '）')
          })))
      )

      // ── 详情：置于列表上方，顶部/底部都有明确的关闭按钮，并支持 ESC ──
      var detail = null
      if (open) {
        var sec = function (title, node) {
          return h('div', { style: { marginBottom: 12 } }, h('div', { style: cap }, title), node)
        }
        var closeButton = function () {
          return h('button', {
            type: 'button', style: closeBtn, title: '关闭详情（Esc）',
            onClick: function () { setOpen(null) },
          }, '✕ 关闭')
        }
        detail = h('div', { style: Object.assign({}, box, { borderColor: ACCENT }) },
          h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 8, flexWrap: 'wrap' } },
            h('div', { style: { fontSize: 15, fontWeight: 800, color: INK, wordBreak: 'break-all' } }, open.name),
            h('div', { style: { fontSize: 12, color: INK2 } }, open.category + '　' + open.level + '　' + (open.source || '')),
            h('div', { style: { flex: 1 } }),
            closeButton()),
          sec('干什么用', h('div', { style: { fontSize: 13, color: INK, lineHeight: 1.65 } }, open.purpose || '（无描述）')),
          (open.triggers || []).length ? sec('触发条件', h('div', null, open.triggers.map(function (t, i) { return h('span', { key: i, style: chip }, t) }))) : null,
          open.boundary ? sec('什么时候不该用', h('div', { style: { fontSize: 12.5, color: INK2, lineHeight: 1.65 } }, open.boundary)) : null,
          (open.headings || []).length ? sec('怎么用 · 正文骨架', h('ol', { style: { margin: 0, paddingLeft: 18, color: INK2, fontSize: 12.5 } },
            open.headings.map(function (x, i) { return h('li', { key: i, style: x.level <= 1 ? { color: INK } : null }, x.text) }))) : null,
          open.preview ? sec('怎么用 · 正文预览', h('pre', {
            style: { margin: 0, padding: '10px 12px', background: 'var(--dsw-alias-bg-layer-3, #f6f8fa)', border: '1px solid ' + LINE, borderRadius: 8, fontSize: 12, lineHeight: 1.55, whiteSpace: 'pre-wrap', color: INK, maxHeight: 280, overflow: 'auto' },
          }, open.preview + (open.previewTruncated ? '\n\n…（已截断，完整内容见 SKILL.md）' : ''))) : null,
          (open.models || []).length ? sec('关联模型', h('div', null, open.models.map(function (m, i) { return h('span', { key: i, style: chip, title: m.scene }, m.name) }))) : null,
          sec('指标', h('div', { style: { fontSize: 12, color: INK2 } },
            '正文 ' + open.bodyLength + ' 字符　·　描述 ' + (open.description || '').length + ' 字符' +
            (open.truncated ? '（超 500，目录注入会截断）' : '') +
            ((open.missingBins || []).length ? '　·　缺依赖：' + open.missingBins.join('、') : ''))),
          open.evidence ? sec('验证证据', h('div', { style: { fontSize: 12, color: INK2 } }, open.evidence)) : null,
          open.note ? sec('备注', h('div', { style: { fontSize: 12, color: INK2 } }, open.note)) : null,
          sec('文件位置', h('div', { style: { fontSize: 12, color: INK2, wordBreak: 'break-all' } }, '~/.agents/skills/' + open.dir + '/SKILL.md')),
          h('div', { style: { display: 'flex', justifyContent: 'flex-end', marginTop: 4 } }, closeButton())
        )
      }

      // ── 列表：自适应卡片，不再用会被挤扁的多列表格 ──
      var listBox = h('div', null, list.slice(0, 150).map(function (s) {
        var active = open && open.name === s.name
        return h('div', {
          key: s.name,
          style: Object.assign({}, item, active ? { borderColor: ACCENT } : null),
          onClick: function () { setOpen(active ? null : s) },
        },
          h('div', { style: itemHead },
            h('span', { style: itemName }, s.name),
            h('span', { style: { fontSize: 11, color: levelColor(s.level), fontWeight: 700 } }, s.level),
            h('span', { style: { fontSize: 11, color: INK2 } }, s.category + (s.source === '本机自建' ? '' : ' · 上游'))),
          h('div', { style: itemPur }, clip(s.purpose, 110)),
          (s.triggers || []).length ? h('div', { style: itemTrg },
            s.triggers.slice(0, 5).map(function (t, i) { return h('span', { key: i, style: chip }, t) })) : null
        )
      }))

      var foot = stats ? h('div', { style: { fontSize: 11.5, color: INK2, marginTop: 2 } },
        '数据时间 ' + (stats.generatedAt ? new Date(stats.generatedAt).toLocaleTimeString('zh-CN') : '—') +
        '　·　技能库 ' + stats.skillsRoot +
        '　·　注册表 ' + (stats.registryPath ? '已连接' : '未找到（缺验证字段）') +
        (list.length > 150 ? '　·　仅显示前 150 条（共 ' + list.length + '）' : '')
      ) : null

      return h('div', { style: { maxWidth: 980 } }, head, errLine, cards, filterBar, detail, listBox, foot)
    }

    var inject = ['slots']

    function apply(ctx) {
      var slots = ctx.get('slots')
      if (!slots || typeof slots.inject !== 'function') return
      slots.inject('settings.section', function () {
        return slots.register(
          // order 45/46/47：与 cost-manager、session-manager 连排（它们都占 45/46）
          { name: 'settings.section', id: 'skill-catalog', order: 47, label: function () { return '技能总览' } },
          function () { return h(Panel, {}) },
        )
      })
      // 不再单独占用侧边栏入口：技能总览已作为「运维看板」的第三个页签（/board#skills）
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
