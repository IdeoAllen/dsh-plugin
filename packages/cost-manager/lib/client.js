// @dachengge/dsh-cost-manager — 浏览器半区（设置页「费用与余额」面板）
//
// DSH 客户端插件 bundle 格式：window.__ModuleLoader__.load({ id, factory })。
// 注意：此文件必须是纯 JavaScript，禁止 import / TypeScript / JSX —— React 由
// 模块加载器注入（require("react")），组件用 React.createElement 构造。
// 数据来自 host 半区注册的 JSON 路由：GET /dsh-cost/api/overview
window.__ModuleLoader__.load({
  id: '@dachengge/dsh-cost-manager',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')
    var h = React.createElement

    var API = '/dsh-cost/api/overview'
    var CACHE_KEY = 'dsh-cost-manager-overview-v1'

    /** 上次成功拿到的 payload：打开面板先用它秒渲染，再后台刷新（stale-while-revalidate）。 */
    function readCachedOverview() {
      try {
        var raw = window.localStorage.getItem(CACHE_KEY)
        if (!raw) return null
        var j = JSON.parse(raw)
        return j && j.ok ? j : null
      } catch (e) {
        return null
      }
    }
    var LAST_OVERVIEW = readCachedOverview() // 模块加载时读一次；Panel 每次挂载都能秒渲染

    function writeCachedOverview(payload) {
      LAST_OVERVIEW = payload
      try {
        window.localStorage.setItem(CACHE_KEY, JSON.stringify(payload))
      } catch (e) {
        /* 隐私模式 / 配额满：缓存失败不影响功能 */
      }
    }
    function agoText(ts) {
      var n = Number(ts)
      if (!isFinite(n)) return ''
      var s = Math.max(0, Math.round((Date.now() - n) / 1000))
      if (s < 60) return s + ' 秒前'
      if (s < 3600) return Math.round(s / 60) + ' 分钟前'
      return Math.round(s / 3600) + ' 小时前'
    }

    // 跟随 DSH 主题的 CSS 变量（带浅色兜底）
    var INK = 'var(--dsw-alias-label-primary, #1f2328)'
    var INK2 = 'var(--dsw-alias-label-secondary, #6b7280)'
    var LINE = 'var(--dsw-alias-border-l2, #e5e7eb)'
    var CARD = 'var(--dsw-alias-bg-layer-2, #ffffff)'
    var WARN = '#c05621'
    var DANGER = '#c53030'
    var OK = '#2f855a'

    function money(n) {
      var v = Number(n)
      return '¥' + (isFinite(v) ? v.toFixed(2) : '—')
    }
    function cnyOf(s) {
      var m = String(s == null ? '' : s).match(/¥(\d+(?:\.\d+)?)/)
      return m ? Number(m[1]) : null
    }
    function humanHours(hh) {
      if (hh === null || !isFinite(hh) || hh < 0) return '—'
      return hh < 48 ? hh.toFixed(1) + ' 小时' : (hh / 24).toFixed(1) + ' 天'
    }
    function fmtTok(n) {
      var v = Number(n) || 0
      return v >= 1e6 ? (v / 1e6).toFixed(2) + 'M' : v >= 1e3 ? Math.round(v / 1e3) + 'K' : String(v)
    }

    var box = { background: CARD, border: '1px solid ' + LINE, borderRadius: 12, padding: '14px 16px', marginBottom: 12 }
    var cap = { fontSize: 12, color: INK2, letterSpacing: '.04em', marginBottom: 10, fontWeight: 700 }
    var rowS = { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10, padding: '5px 0', fontSize: 13, borderTop: '1px dashed ' + LINE }
    var mono = { fontFamily: 'Consolas,monospace', fontSize: 12.5 }

    function Panel() {
      var s = React.useState(LAST_OVERVIEW) // 有缓存就首帧直出，避免整屏"加载中…"
      var data = s[0]
      var setData = s[1]
      var se = React.useState('')
      var err = se[0]
      var setErr = se[1]
      var sl = React.useState(false)
      var loading = sl[0]
      var setLoading = sl[1]

      var load = React.useCallback(function (force) {
        setLoading(true)
        setErr('')
        fetch(API + (force ? '?force=1' : ''), { cache: 'no-store' })
          .then(function (r) {
            return r.json()
          })
          .then(function (j) {
            if (j && j.ok) {
              setData(j)
              writeCachedOverview(j)
              setErr('')
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
        load(false)
      }, [load])

      var head = h(
        'div',
        { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 } },
        h('div', null, h('div', { style: { fontSize: 16, fontWeight: 800, color: INK } }, '费用与余额'), h('div', { style: { fontSize: 12, color: INK2, marginTop: 2 } }, '各平台余额 · 消耗速率 · 距硬地板可撑时长')),
        h(
          'button',
          {
            type: 'button',
            onClick: function () {
              load(true) // 手动刷新：绕过服务端缓存强制重测
            },
            disabled: loading,
            style: {
              border: '1px solid ' + LINE, background: 'transparent', color: INK, cursor: loading ? 'default' : 'pointer',
              borderRadius: 8, padding: '5px 12px', fontSize: 12.5, opacity: loading ? 0.5 : 1,
            },
          },
          loading ? '刷新中…' : '刷新',
        ),
      )

      if (!data) {
        return h(
          'div',
          { style: { color: err ? DANGER : INK2, fontSize: 13, padding: '10px 0' } },
          err ? '加载失败：' + err + '（确认 host 半区已加载该插件）' : '加载中…（首次打开需探测各平台余额并扫描会话，约 5–10 秒；之后从缓存秒开）',
        )
      }

      var bals = data.balances || []
      var floors = data.floors || {}
      var alerts = data.alerts || {}
      var burn = (data.burn && data.burn.byPlatform) || []

      // 消耗速率 + 可撑时长
      var speed = burn.map(function (b) {
        var found = null
        for (var i = 0; i < bals.length; i++) if (bals[i].platform === b.platform) found = bals[i]
        var floor = floors[b.platform]
        var bal = found ? cnyOf(found.balance) : null
        var hh = bal !== null && floor !== undefined && b.ratePerHour > 0 ? (bal - floor) / b.ratePerHour : null
        var danger = hh !== null && hh < 2
        return h(
          'div',
          { key: b.platform, style: rowS },
          h('span', { style: { color: INK } }, b.platform),
          h('span', { style: Object.assign({}, mono, { color: INK }) }, '¥' + b.ratePerHour.toFixed(2) + '/h'),
          h('span', { style: { color: danger ? DANGER : INK2, fontWeight: danger ? 700 : 400 } }, hh === null ? '' : '距硬地板 ¥' + floor + ' 可撑 ' + humanHours(hh) + (danger ? ' ⚠️' : '')),
        )
      })

      var speedBox = h(
        'div',
        { style: box },
        h('div', { style: cap }, '消耗速率' + (data.burn ? '（最近 ' + data.burn.windowHours + 'h 窗口 · 活跃跨度 ' + (data.burn.spanHours || 0).toFixed(1) + 'h）' : '')),
        speed.length ? speed : h('div', { style: { fontSize: 12.5, color: INK2 } }, '最近窗口内无会话活动，暂无速率'),
      )

      // 平台余额
      var balRows = bals.map(function (b) {
        var v = cnyOf(b.balance)
        var a = alerts[b.platform]
        var f = floors[b.platform]
        var low = v !== null && a !== undefined && v < a
        var below = v !== null && f !== undefined && v < f
        return h(
          'div',
          { key: b.platform, style: rowS },
          h('span', { style: { color: INK, minWidth: 130 } }, b.platform),
          h('span', { style: Object.assign({}, mono, { color: below ? DANGER : INK }) }, b.balance || '—'),
          h(
            'span',
            { style: { color: below ? DANGER : low ? WARN : INK2, fontSize: 12 } },
            below ? '⛔ 低于硬地板 ¥' + f : low ? '⚠️ 低于预警线 ¥' + a : b.status || '',
          ),
        )
      })
      var balBox = h('div', { style: box }, h('div', { style: cap }, '平台余额'), balRows)

      // LLM 用量 + 两套账（账 A 估费 / 账 B 实付 / 待补），口径不同不可相加
      var u = data.usage || {}
      var L = data.ledger || {}
      var usageBox = h(
        'div',
        { style: box },
        h('div', { style: cap }, '两套账（口径不同，勿相加）'),
        h(
          'div',
          { style: { display: 'flex', gap: 22, fontSize: 13, color: INK, flexWrap: 'wrap' } },
          h('span', null, h('b', null, money(u.cost)), h('span', { style: { color: INK2 } }, ' 账A·估费')),
          h('span', null, h('b', null, fmtTok(u.tokens)), h('span', { style: { color: INK2 } }, ' token')),
          h('span', null, h('b', null, String(u.msgs || 0)), h('span', { style: { color: INK2 } }, ' 条消息')),
          h('span', null, h('b', null, money(L.total)), h('span', { style: { color: INK2 } }, ' 账B·实付（' + (L.count || 0) + ' 笔）')),
          h(
            'span',
            null,
            h('b', { style: { color: L.pending ? WARN : INK } }, String(L.pending || 0) + ' 笔'),
            h('span', { style: { color: INK2 } }, ' 账B·成本待补'),
          ),
        ),
        L.byPlatform && L.byPlatform.length
          ? h(
              'div',
              { style: { marginTop: 10 } },
              h('div', { style: { fontSize: 11.5, color: INK2, marginBottom: 4 } }, '账 B 实付分布（按平台）'),
              L.byPlatform.map(function (p) {
                return h(
                  'div',
                  { key: p.platform, style: rowS },
                  h('span', { style: { color: INK } }, p.platform),
                  h('span', { style: Object.assign({}, mono, { color: INK }) }, money(p.cost)),
                  h('span', { style: { color: INK2, fontSize: 12 } }, p.count + ' 笔' + (p.pending ? '（' + p.pending + ' 笔待补）' : '')),
                )
              }),
            )
          : null,
      )

      var footBits = [
        '数据时间 ' + new Date(data.updatedAt).toLocaleTimeString('zh-CN') + '（' + agoText(Date.parse(data.updatedAt)) + '）',
        loading ? '刷新中…' : '',
        data.scan && data.scan.cached ? '会话数据命中缓存' : '',
        data.scan && data.scan.failedFiles ? '⚠️ ' + data.scan.failedFiles + ' 个会话读取失败（未计入统计）' : '',
        '估费按 token 单价分价、缓存命中单算，仅供参考',
      ].filter(Boolean)
      var foot = h('div', { style: { fontSize: 11.5, color: INK2, marginTop: 2 } }, footBits.join('　·　'))

      var errStrip = err
        ? h('div', { style: { fontSize: 12, color: DANGER, marginBottom: 8 } }, '刷新失败：' + err + '（下面显示的是上次成功的数据）')
        : null

      return h('div', { style: { maxWidth: 720 } }, head, errStrip, speedBox, balBox, usageBox, foot)
    }

    var inject = ['slots']

    function apply(ctx) {
      var slots = ctx.get('slots')
      if (!slots || typeof slots.inject !== 'function') return
      slots.inject('settings.section', function () {
        return slots.register(
          // order 45/46/47：dshmarket 与 vision-router 都占用 40，平级会按注册先后错开；
          // 三个自研插件改用不冲突的连续值，设置页里才会连排。
          { name: 'settings.section', id: 'cost-manager', order: 45, label: function () { return '费用与余额' } },
          function () {
            return h(Panel, {})
          },
        )
      })

      // 侧栏底部入口：一键打开运维看板（/board —— 费用与余额 + 会话管理，一个标签两个页签）
      slots.inject('sidebar.footer.action', function () {
        return slots.register({ name: 'sidebar.footer.action', id: 'ops-board', order: 80 }, function () {
          return h(
            'a',
            {
              href: '/board',
              target: '_blank',
              rel: 'noopener',
              title: '运维看板：费用与余额 + 会话管理（新标签打开）',
              style: {
                color: INK2,
                textDecoration: 'none',
                fontSize: 12.5,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '4px 8px',
                borderRadius: 7,
                border: '1px solid ' + LINE,
              },
            },
            '📊',
            h('span', null, '运维看板'),
          )
        })
      })
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
