/**
 * pricing.mjs —— 用量估费（按模型单价分价 + 缓存命中单算）
 *
 * 单一事实来源：catalog.json 里 kind=llm 且 unit="1M token" 的模型单价。
 * 缓存命中费率默认 ¥0.02/1M（DeepSeek 官方 2026-09 降价后价），
 * 可在 config.cacheRateCnyPer1M 覆盖。未在价目表的模型回退到
 * config.tokenRateCnyPer1M（全局混合费率）。
 */

/**
 * 模型 id → 单价（¥/1M token）映射。
 * 三种情况：
 *   1) 已登记 token 单价（unit="1M token" 且 price 是数字）→ 用该单价
 *   2) 已登记但非 token 计价（如 coding 订阅套餐，unit="套餐"）→ 记 0（本次用量不产生按量费）
 *   3) 完全未登记 → 不在 map 里，由调用方回退全局 tokenRateCnyPer1M
 */
export function buildModelPriceMap(catalog) {
  const map = new Map()
  for (const m of catalog?.models || []) {
    if (m.kind !== 'llm') continue
    if (m.unit === '1M token' && typeof m.price === 'number') map.set(m.id, m.price)
    else if (m.unit !== '1M token') map.set(m.id, 0)
  }
  return map
}

/** 单条消息估费（¥） */
export function estimateMessageCost(m, priceMap, fallbackRate, cacheRate) {
  const nonCache = (m.inTokens || 0) + (m.outTokens || 0) + (m.reasoningTokens || 0)
  const cache = m.cacheReadTokens || 0
  // 注意：套餐模型单价是 0，必须用 ?? 而非 || —— 0 是 falsy，用 || 会被 fallback 覆盖
  const rate = priceMap.get(m.model) ?? fallbackRate
  return (nonCache / 1e6) * rate + (cache / 1e6) * cacheRate
}

/** 一组消息估费合计（¥） */
export function estimateCost(messages, catalog, config) {
  const priceMap = buildModelPriceMap(catalog)
  const fallbackRate = Number(config?.tokenRateCnyPer1M || 5)
  const cacheRate = Number(config?.cacheRateCnyPer1M ?? 0.02)
  return messages.reduce((s, m) => s + estimateMessageCost(m, priceMap, fallbackRate, cacheRate), 0)
}

/** DSH 的 provider id → 余额平台名（把消耗对到具体平台的余额上） */
export function providerToPlatform(provider) {
  const p = String(provider || '').toLowerCase()
  if (p.includes('deepseek')) return 'DeepSeek'
  if (p.includes('moonshot') || p.includes('kimi')) return 'Kimi (Moonshot)'
  if (p.includes('zai') || p.includes('zhipu') || p.includes('glm')) return '智谱(ZAI)'
  return null
}

/**
 * 消耗速率（防死预测）：取最近 windowHours 小时内已落盘的消息，
 * 按「活跃跨度」摊算 ¥/小时。用 ts（毫秒）滑窗，不用 day（day 是 UTC 日期）。
 * 必须按平台聚合：同平台多个 provider（deepseek-official + deepseek）共用一份余额。
 */
export function computeBurn(messages, catalog, config, windowHours = 6) {
  const now = Date.now()
  const recent = (messages || []).filter((m) => (m.ts || 0) >= now - windowHours * 3600_000)
  if (!recent.length) return { windowHours, spanHours: 0, byPlatform: [] }
  const first = Math.min(...recent.map((m) => m.ts))
  const spanHours = Math.max((now - first) / 3600_000, 0.25) // 下限 15 分钟，避免除零放大
  const groups = new Map()
  for (const m of recent) {
    const prov = String(m.provider || 'unknown')
    const key = providerToPlatform(prov) || prov
    const g = groups.get(key) || { platform: key, arr: [], providers: new Set() }
    g.arr.push(m)
    g.providers.add(prov)
    groups.set(key, g)
  }
  const byPlatform = [...groups.values()].map((g) => {
    const cost = estimateCost(g.arr, catalog, config)
    return { platform: g.platform, cost, msgs: g.arr.length, providers: [...g.providers], ratePerHour: cost / spanHours }
  })
  return { windowHours, spanHours, byPlatform }
}

/** 小时数说成人话：<48h 说小时，否则说天 */
export function humanHours(h) {
  if (!Number.isFinite(h) || h < 0) return '—'
  return h < 48 ? `${h.toFixed(1)} 小时` : `${(h / 24).toFixed(1)} 天`
}
