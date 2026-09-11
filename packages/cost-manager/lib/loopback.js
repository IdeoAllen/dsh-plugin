/**
 * loopback 围栏 —— 只放行来自本机的请求。
 *
 * 为什么需要
 *   DSH 的插件路由（`ctx.webServer.register`）**不在应用外壳的鉴权门后面**：
 *   实测 `GET /` 返回 401，但 `GET /skills`、`/dshm`、`/cost` 都返回 200。
 *   若不自行校验，存在两类风险：
 *
 *   1. **DNS rebinding**：恶意网页把自己的域名解析到 127.0.0.1，浏览器会把它
 *      当作同源，从而可直接读取本插件返回的内容（如全部技能正文）。
 *      —— Host 头校验正是针对这一类。
 *   2. **绑定到局域网时无鉴权暴露**：一旦用 `--host 0.0.0.0` 启动，或装了
 *      远程 UI 插件，同网段任何人都能读取。
 *      —— socket 远端地址校验针对这一类。
 *
 * 做法
 *   socket 远端地址与 Host 头**都**必须是 loopback 才放行。
 *   两条都校验是刻意的：只查远端地址挡不住 DNS rebinding（请求確實来自本机），
 *   只查 Host 头挡不住真正的远程连接。
 *
 * 说明
 *   本模块在三份插件里各存一份，是**刻意**的：DSH 插件要求自包含，
 *   不允许跨包相对路径依赖（见 dshm / cost-manager 的设计约束）。
 *   改动时三处需同步。
 */

/** 是否是 loopback 的 IPv4/IPv6 地址字面量（含 IPv4-mapped IPv6）。 */
export function isLoopbackAddress(address) {
  if (!address) return false
  let a = String(address).trim().toLowerCase()
  if (a.startsWith('[') && a.endsWith(']')) a = a.slice(1, -1)
  // IPv4-mapped IPv6，例如 ::ffff:127.0.0.1
  if (a.startsWith('::ffff:')) a = a.slice(7)
  if (a === '::1' || a === '0:0:0:0:0:0:0:1') return true
  const m = a.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!m) return false
  const octets = m.slice(1).map(Number)
  if (octets.some((n) => n > 255)) return false
  return octets[0] === 127
}

/** 是否是 loopback 的主机名/字面量（localhost、127/8、::1）。 */
export function isLoopbackHostname(hostname) {
  if (!hostname) return false
  let h = String(hostname).trim().toLowerCase()
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1)
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  if (h === '::1' || h === '0:0:0:0:0:0:0:1') return true
  return isLoopbackAddress(h)
}

/**
 * 从 Host 头解析主机名（去掉端口）。
 * 兼容 `127.0.0.1:3082`、`localhost:3082`、`[::1]:3082`、`[::1]`。
 */
export function hostnameOf(hostHeader) {
  const raw = String(hostHeader || '').trim()
  if (raw === '') return ''
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']')
    return end === -1 ? raw : raw.slice(1, end)
  }
  const colon = raw.lastIndexOf(':')
  // 只有一个冒号才当端口分隔符（多个冒号是裸 IPv6）
  if (colon !== -1 && raw.indexOf(':') === colon) return raw.slice(0, colon)
  return raw
}

/**
 * 请求是否来自本机。
 * @param req Node 的 IncomingMessage
 * @returns {{ ok: boolean, reason?: string, remote?: string, host?: string }}
 */
export function checkLoopback(req) {
  const remote = req?.socket?.remoteAddress
  const host = hostnameOf(req?.headers?.host)
  if (!isLoopbackAddress(remote)) {
    return { ok: false, reason: `remote address is not loopback: ${remote || '(unknown)'}`, remote, host }
  }
  if (!isLoopbackHostname(host)) {
    return { ok: false, reason: `host header is not loopback: ${host || '(missing)'}（疑似 DNS rebinding）`, remote, host }
  }
  return { ok: true, remote, host }
}
