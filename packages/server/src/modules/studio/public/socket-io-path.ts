/**
 * Sub-path deployment (BASE_URL=/hermes/): Socket.IO upgrade handshakes bypass
 * Koa middleware, so the server attaches Socket.IO at the prefixed path
 * (e.g. /hermes/socket.io). Any server-internal socket.io-client that dials
 * back into this same server MUST pass this as the `path` option, otherwise
 * the client hits the unprefixed /socket.io which the Koa SPA fallback
 * answers with index.html (no handshake) → socket hang up.
 *
 * Returns the full client `path` option value, e.g. '/hermes/socket.io'.
 *
 * Kept in its own module (not `public/config`) on purpose: many upstream tests
 * mock `public/config` with a bare `{ config }` object, which would make this
 * import resolve to `undefined` and break the socket dial at call time.
 */
export function socketIoClientPath(env: Record<string, string | undefined> = process.env): string {
  const basePath = (env.BASE_URL || env.HERMES_BASE_PATH || '').replace(/\/+$/, '')
  return basePath ? `${basePath}/socket.io` : '/socket.io'
}
