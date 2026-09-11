// @dachengge/dsh-session-manager — 浏览器半区（设置页「会话管理」面板）
//
// DSH 客户端插件 bundle 格式：window.__ModuleLoader__.load({ id, factory })。
// 注意：此文件必须是纯 JavaScript，禁止 import / TypeScript / JSX —— React 由
// 模块加载器注入（require("react")），组件用 React.createElement 构造。
// 数据来自 host 半区注册的路由：/dshm/api/*
window.__ModuleLoader__.load({
  id: '@dachengge/dsh-session-manager',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')
    var h = React.createElement

    var API = '/dshm/api/overview'
    var FULL_PAGE = '/dshm'
    var CACHE_KEY = 'dsh-session-manager-overview-v1'

    // 跟随 DSH 主题的 CSS 变量（带浅色兜底）
    var INK = 'var(--dsw-alias-label-primary, #1f2328)'
    var INK2 = 'var(--dsw-alias-label-secondary, #6b7280)'
    var LINE = 'var(--dsw-alias-border-l2, #e5e7eb)'
    var CARD = 'var(--dsw-alias-bg-layer-2, #ffffff)'
    var WARN = '#c05621'
    var DANGER = '#c53030'
    var OK = '#2f855a'
    var ACCENT = '#3b82f6'

    function fmtTok(n) {
      var v = Number(n) || 0
      return v >= 1e6 ? (v / 1e6).toFixed(2) + 'M' : v >= 1e3 ? Math.round(v / 1e3) + 'K' : String(v)
    }
    function agoText(ts) {
      var n = Number(ts)
      if (!isFinite(n)) return ''
      var s = Math.max(0, Math.round((Date.now() - n) / 1000))
      if (s < 60) return s + ' 秒前'
      if (s < 3600) return Math.round(s / 60) + ' 分钟前'
      if (s < 86400) return Math.round(s / 3600) + ' 小时前'
      return Math.round(s / 86400) + ' 天前'
    }
    function readCached() {
      try {
        var raw = window.localStorage.getItem(CACHE_KEY)
        if (!raw) return null
        var j = JSON.parse(raw)
        return j && j.sessionList ? j : null
      } catch (e) {
        return null
      }
    }
    var LAST_OVERVIEW = readCached()
    function writeCached(payload) {
      LAST_OVERVIEW = payload
      try {
        window.localStorage.setItem(CACHE_KEY, JSON.stringify(payload))
      } catch (e) {
        /* 隐私模式 / 配额满：静默 */
      }
    }

    var box = { background: CARD, border: '1px solid ' + LINE, borderRadius: 12, padding: '14px 16px', marginBottom: 12 }
    var cap = { fontSize: 12, color: INK2, letterSpacing: '.04em', marginBottom: 10, fontWeight: 700 }
    var cardRow = { display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 12 }
    var miniCard = { flex: '1 1 120px', background: CARD, border: '1px solid ' + LINE, borderRadius: 12, padding: '10px 14px' }
    var miniLabel = { fontSize: 11.5, color: INK2, marginBottom: 4 }
    var miniValue = { fontSize: 19, fontWeight: 800, color: INK }
    var btn = {
      border: '1px solid ' + LINE,
      background: 'transparent',
      color: INK,
      cursor: 'pointer',
      borderRadius: 8,
      padding: '5px 12px',
      fontSize: 12.5,
    }
    var th = { textAlign: 'left', fontSize: 11.5, color: INK2, fontWeight: 600, padding: '6px 8px', borderBottom: '1px solid ' + LINE }
    var td = { fontSize: 12.5, color: INK, padding: '6px 8px', borderBottom: '1px dashed ' + LINE }
    // ── 列表卡片约定：与 skill-catalog / cost-manager 面板保持同一套数值 ──
    var item = { border: '1px solid ' + LINE, borderRadius: 10, padding: '9px 12px', marginBottom: 8, cursor: 'pointer', background: 'transparent' }
    var itemHead = { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }
    var itemId = { fontSize: 12, color: ACCENT, fontWeight: 700, fontFamily: 'monospace' }
    var itemTitle = { fontSize: 13, fontWeight: 600, color: INK, flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
    var itemTag = { fontSize: 11, color: INK2 }
    // 次级说明文字：统一 12px / INK2（skill-catalog 的 itemPur 同值）
    var itemMeta = { fontSize: 12, color: INK2, lineHeight: 1.5, marginTop: 3, display: 'flex', gap: 12, flexWrap: 'wrap' }

    /** 每步 token 用量的小柱状图（内联 SVG，不引第三方库）。 */
    function TrendChart(points) {
      if (!points || !points.length) return h('div', { style: { fontSize: 12, color: INK2 } }, '该会话没有可用的 usage 记录')
      var tail = points.slice(-140)
      var max = 1
      for (var i = 0; i < tail.length; i++) {
        var v = (tail[i].inputTokens || 0) + (tail[i].outputTokens || 0) + (tail[i].reasoningTokens || 0)
        if (v > max) max = v
      }
      var w = 8
      var height = 64
      var bars = tail.map(function (p, idx) {
        var v = (p.inputTokens || 0) + (p.outputTokens || 0) + (p.reasoningTokens || 0)
        var bh = Math.max(1, Math.round((v / max) * height))
        return h('rect', {
          key: idx,
          x: idx * w,
          y: height - bh,
          width: w - 1.5,
          height: bh,
          fill: idx === tail.length - 1 ? ACCENT : INK2,
          opacity: idx === tail.length - 1 ? 1 : 0.55,
        })
      })
      return h(
        'div',
        null,
        h('svg', { width: '100%', height: height + 6, viewBox: '0 0 ' + tail.length * w + ' ' + height, preserveAspectRatio: 'none' }, bars),
        h(
          'div',
          { style: { fontSize: 11.5, color: INK2, marginTop: 4 } },
          '最近 ' + tail.length + ' 步 · 峰值 ' + fmtTok(max) + ' token/步 · 合计 ' + fmtTok(points.reduce(function (a, p) { return a + (p.inputTokens || 0) + (p.outputTokens || 0) + (p.reasoningTokens || 0) }, 0)),
        ),
      )
    }

    function Panel() {
      var s0 = React.useState(LAST_OVERVIEW)
      var data = s0[0]
      var setData = s0[1]
      var s1 = React.useState('')
      var err = s1[0]
      var setErr = s1[1]
      var s2 = React.useState(false)
      var loading = s2[0]
      var setLoading = s2[1]
      var s3 = React.useState('')
      var query = s3[0]
      var setQuery = s3[1]
      var s4 = React.useState(null)
      var hits = s4[0]
      var setHits = s4[1]
      var s5 = React.useState(null)
      var sel = s5[0]
      var setSel = s5[1]
      var s6 = React.useState(null)
      var trend = s6[0]
      var setTrend = s6[1]
      var s7 = React.useState('')
      var note = s7[0]
      var setNote = s7[1]

      var load = React.useCallback(function () {
        setLoading(true)
        setErr('')
        fetch(API, { cache: 'no-store' })
          .then(function (r) {
            return r.json()
          })
          .then(function (j) {
            if (j && j.sessionList) {
              setData(j)
              writeCached(j)
            } else {
              setErr((j && j.error) || '返回数据异常')
            }
          })
          .catch(function (e) {
            setErr(String(e && e.message ? e.message : e))
          })
          .finally(function () {
            setLoading(false)
          })
      }, [])

      React.useEffect(function () {
        load()
      }, [load])

      function runSearch(q) {
        var needle = (q == null ? query : q).trim()
        if (!needle) {
          setHits(null)
          return
        }
        setLoading(true)
        setNote('')
        fetch('/dshm/api/search?q=' + encodeURIComponent(needle), { cache: 'no-store' })
          .then(function (r) {
            return r.json()
          })
          .then(function (j) {
            setHits(Array.isArray(j) ? j : [])
            setNote('搜索「' + needle + '」命中 ' + (Array.isArray(j) ? j.length : 0) + ' 条')
          })
          .catch(function (e) {
            setNote('搜索失败：' + String(e && e.message ? e.message : e))
          })
          .finally(function () {
            setLoading(false)
          })
      }

      function openSession(id) {
        setSel({ id: id, loading: true })
        setTrend(null)
        fetch('/dshm/api/session?id=' + encodeURIComponent(id), { cache: 'no-store' })
          .then(function (r) {
            return r.json()
          })
          .then(function (j) {
            setSel({ id: id, detail: j })
          })
          .catch(function (e) {
            setSel({ id: id, error: String(e && e.message ? e.message : e) })
          })
        fetch('/dshm/api/trend?id=' + encodeURIComponent(id), { cache: 'no-store' })
          .then(function (r) {
            return r.json()
          })
          .then(function (j) {
            setTrend(Array.isArray(j) ? j : [])
          })
          .catch(function () {
            setTrend([])
          })
      }

      function toggleArchive(id, archived) {
        fetch('/dshm/api/archive?id=' + encodeURIComponent(id) + '&archived=' + (archived ? 'true' : 'false'), { method: 'POST' })
          .then(function () {
            setNote(archived ? '已归档' : '已取消归档')
            load()
          })
          .catch(function (e) {
            setNote('归档失败：' + String(e && e.message ? e.message : e))
          })
      }

      function copyUri(uri) {
        try {
          window.navigator.clipboard.writeText(uri)
          setNote('已复制引用：' + uri.slice(0, 48) + '…')
        } catch (e) {
          setNote('复制失败，请手动选择')
        }
      }

      var head = h(
        'div',
        { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6, gap: 10 } },
        h(
          'div',
          null,
          h('div', { style: { fontSize: 16, fontWeight: 800, color: INK } }, '会话管理'),
          h('div', { style: { fontSize: 12, color: INK2, marginTop: 2 } }, '会话列表 · 全文搜索 · 每步 token 趋势 · 导出 · 归档（dshm，已并入 3082）'),
        ),
        h(
          'div',
          { style: { display: 'flex', gap: 8, flexShrink: 0 } },
          h(
            'a',
            { href: FULL_PAGE, target: '_blank', rel: 'noopener', style: Object.assign({}, btn, { textDecoration: 'none', display: 'inline-block' }) },
            '打开完整界面 ↗',
          ),
          h('button', { type: 'button', onClick: load, disabled: loading, style: Object.assign({}, btn, { opacity: loading ? 0.5 : 1 }) }, loading ? '刷新中…' : '刷新'),
        ),
      )

      if (!data) {
        return h(
          'div',
          { style: { color: err ? DANGER : INK2, fontSize: 13, padding: '10px 0' } },
          err ? '加载失败：' + err + '（确认 host 半区已加载该插件）' : '加载中…',
        )
      }

      var sessions = data.sessionList || []
      var workspaces = data.workspaceList || []
      var goal = data.goal || null

      var cards = h(
        'div',
        { style: cardRow },
        h('div', { style: miniCard }, h('div', { style: miniLabel }, '工作区'), h('div', { style: miniValue }, String(workspaces.length))),
        h('div', { style: miniCard }, h('div', { style: miniLabel }, '会话'), h('div', { style: miniValue }, String(data.activeSessions != null ? data.activeSessions : sessions.filter(function (x) { return !x.archived }).length))),
        h('div', { style: miniCard }, h('div', { style: miniLabel }, '已归档'), h('div', { style: miniValue }, String(data.archivedSessions != null ? data.archivedSessions : sessions.filter(function (x) { return x.archived }).length))),
        h(
          'div',
          { style: Object.assign({}, miniCard, { flex: '2 1 260px' }) },
          h('div', { style: miniLabel }, '当前目标'),
          h(
            'div',
            { style: { fontSize: 12.5, color: INK, lineHeight: 1.5 } },
            goal
              ? String(goal.objective || goal.title || goal.summary || '—').slice(0, 100) + (goal.phase ? '（' + goal.phase + '）' : '')
              : '—',
          ),
        ),
      )

      var searchBox = h(
        'div',
        { style: box },
        h('div', { style: cap }, '跨会话全文搜索'),
        h(
          'div',
          { style: { display: 'flex', gap: 8 } },
          h('input', {
            value: query,
            placeholder: '输入关键词后回车（搜索所有会话的用户/助手文本）',
            onChange: function (e) {
              setQuery(e.target.value)
            },
            onKeyDown: function (e) {
              if (e.key === 'Enter') runSearch(null)
            },
            style: { flex: 1, background: 'transparent', color: INK, border: '1px solid ' + LINE, borderRadius: 8, padding: '6px 10px', fontSize: 12.5, outline: 'none' },
          }),
          h('button', { type: 'button', onClick: function () { runSearch(null) }, disabled: loading, style: Object.assign({}, btn, { opacity: loading ? 0.5 : 1 }) }, '搜索'),
        ),
        hits
          ? h(
              'div',
              { style: { marginTop: 10, maxHeight: 220, overflowY: 'auto' } },
              hits.length === 0
                ? h('div', { style: { fontSize: 12.5, color: INK2 } }, '没有命中')
                : hits.map(function (x, i) {
                    return h(
                      'div',
                      { key: i, style: { padding: '6px 0', borderTop: '1px dashed ' + LINE } },
                      h(
                        'div',
                        { style: { fontSize: 12, color: INK2 } },
                        h('span', { style: { color: ACCENT, cursor: 'pointer' } , onClick: function () { openSession(x.sessionId) } }, x.shortId),
                        ' · ' + (x.role === 'user' ? '用户' : '助手') + ' · ' + (x.workspace || '') + (x.model ? ' · ' + x.model : ''),
                      ),
                      h('div', { style: { fontSize: 12.5, color: INK, marginTop: 2, whiteSpace: 'pre-wrap' } }, x.snippet),
                    )
                  }),
            )
          : null,
      )

      // ── 会话列表：自适应卡片 ──
      // 原来是 7 列表格（ID/标题/工作区/步数/上下文/更新/状态），在 ~500px 的设置面板里
      // 会被挤到折行（"17%" 与 "小时前" 分家）。改用卡片，任何宽度都不塌。
      var sessionCards = sessions.map(function (s) {
        var ctxPct = s.contextPct == null ? null : Number(s.contextPct)
        var danger = ctxPct != null && ctxPct >= 85
        var selected = sel && sel.id === s.id
        return h(
          'div',
          {
            key: s.id,
            style: Object.assign({}, item, s.archived ? { opacity: 0.55 } : null, selected ? { borderColor: ACCENT } : null),
            onClick: function () { openSession(s.id) },
          },
          h('div', { style: itemHead },
            h('span', { style: itemId }, s.shortId),
            h('span', { style: itemTitle, title: s.title || '' }, s.title || '(无标题)'),
            s.archived ? h('span', { style: itemTag }, '已归档') : null),
          h('div', { style: itemMeta },
            h('span', null, s.workspace || '—'),
            h('span', null, '步数 ' + String(s.steps || 0)),
            h('span', { style: danger ? { color: DANGER, fontWeight: 700 } : null }, '上下文 ' + (ctxPct == null ? '—' : ctxPct.toFixed(0) + '%')),
            h('span', null, s.updatedAt ? agoText(s.updatedAt) : '')),
        )
      })

      var table = h(
        'div',
        { style: box },
        h('div', { style: cap }, '会话（点击查看详情）'),
        sessions.length === 0
          ? h('div', { style: { fontSize: 12.5, color: INK2 } }, '没有会话')
          : h('div', { style: { maxHeight: 300, overflowY: 'auto', marginTop: 2 } }, sessionCards),
      )

      var detailBox = null
      if (sel) {
        var d = sel.detail
        var kv = []
        if (d && !d.ambiguous) {
          var stats = d.stats || {}
          var usage = d.tokenUsage || {}
          var ctx = d.contextPressure || {}
          kv = [
            ['会话 id', d.id],
            ['工作区', d.workspace || ''],
            ['目录', d.cwd || ''],
            ['创建', d.createdAt ? new Date(d.createdAt).toLocaleString('zh-CN') : '—'],
            ['更新', d.updatedAt ? new Date(d.updatedAt).toLocaleString('zh-CN') : '—'],
            ['步数 / 轮次', String(stats.steps != null ? stats.steps : '—') + ' / ' + String(stats.turns != null ? stats.turns : '—')],
            ['token', '入 ' + fmtTok(usage.inputTokens) + ' · 出 ' + fmtTok(usage.outputTokens) + ' · 缓存读 ' + fmtTok(usage.cacheReadTokens)],
            ['上下文', ctx.percent != null ? Number(ctx.percent).toFixed(1) + '%（' + fmtTok(ctx.used) + ' / ' + fmtTok(ctx.window) + '）' : '—'],
            ['引用', d.resumeUri || ''],
          ]
        }
        detailBox = h(
          'div',
          { style: box },
          h(
            'div',
            { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
            h('div', { style: cap }, '会话详情'),
            h('button', { type: 'button', onClick: function () { setSel(null); setTrend(null) }, style: btn }, '关闭'),
          ),
          sel.loading ? h('div', { style: { fontSize: 12.5, color: INK2 } }, '加载中…') : null,
          sel.error ? h('div', { style: { fontSize: 12.5, color: DANGER } }, '加载失败：' + sel.error) : null,
          d && d.ambiguous ? h('div', { style: { fontSize: 12.5, color: WARN } }, 'id 前缀不唯一，匹配到 ' + d.ambiguous.length + ' 个会话，请用更长的 id') : null,
          kv.length
            ? h(
                'div',
                { style: { marginBottom: 10 } },
                kv.map(function (pair, i) {
                  return h(
                    'div',
                    { key: i, style: { display: 'flex', gap: 10, fontSize: 12.5, padding: '3px 0', borderTop: '1px dashed ' + LINE } },
                    h('span', { style: { color: INK2, minWidth: 84 } }, pair[0]),
                    h('span', { style: { color: INK, wordBreak: 'break-all' } }, pair[1]),
                  )
                }),
              )
            : null,
          d && !d.ambiguous
            ? h(
                'div',
                { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 } },
                h('a', { href: '/dshm/api/export?id=' + encodeURIComponent(d.id) + '&format=md', style: Object.assign({}, btn, { textDecoration: 'none', display: 'inline-block' }) }, '导出 Markdown'),
                h('a', { href: '/dshm/api/export?id=' + encodeURIComponent(d.id) + '&format=json', style: Object.assign({}, btn, { textDecoration: 'none', display: 'inline-block' }) }, '导出 JSON'),
                h('button', { type: 'button', onClick: function () { toggleArchive(d.id, !d.archived) }, style: btn }, d.archived ? '取消归档' : '归档'),
                h('button', { type: 'button', onClick: function () { copyUri(d.resumeUri) }, style: btn }, '复制会话引用'),
              )
            : null,
          h('div', { style: cap }, '每步 token 用量'),
          TrendChart(trend),
        )
      }

      var footBits = ['数据时间 ' + (data.updatedAt ? new Date(data.updatedAt).toLocaleTimeString('zh-CN') : '—'), loading ? '刷新中…' : '', 'home: ' + (data.home || '')].filter(Boolean)
      var foot = h('div', { style: { fontSize: 11.5, color: INK2, marginTop: 2 } }, footBits.join('　·　'))
      var noteLine = note ? h('div', { style: { fontSize: 12, color: INK2, marginBottom: 8 } }, note) : null
      var errLine = err ? h('div', { style: { fontSize: 12, color: DANGER, marginBottom: 8 } }, '刷新失败：' + err + '（下面显示的是上次成功的数据）') : null

      return h('div', { style: { maxWidth: 860 } }, head, errLine, noteLine, cards, searchBox, detailBox, table, foot)
    }

    var inject = ['slots']

    function apply(ctx) {
      var slots = ctx.get('slots')
      if (!slots || typeof slots.inject !== 'function') return
      slots.inject('settings.section', function () {
        // order 45/46/47：与 cost-manager、skill-catalog 连排（见那两个插件的同款注释）
        return slots.register({ name: 'settings.section', id: 'session-manager', order: 46, label: function () { return '会话管理' } }, function () {
          return h(Panel, {})
        })
      })
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
