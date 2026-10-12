// Production relay on Cloudflare Workers. Same job as relay/server.mjs, but for many
// visitors at once: every browser tab gets its own Durable Object, which holds the
// tab's WebSocket and its public URL https://<host>/s/<id>/...
//
//   curl ──HTTPS──▶ Worker ──▶ TabTunnel(id) ──WebSocket──▶ that visitor's tab (Hono in wasm)
//
// The page itself (index.html, main.js, wasm) is served as static assets.
import { Hono } from 'hono'
import { DurableObject } from 'cloudflare:workers'

type Env = { TABS: DurableObjectNamespace<TabTunnel> }

const ID_RE = /^[a-z0-9]{16}$/
const MAX_BODY_BYTES = 1024 * 1024
const TIMEOUT_MS = 30_000
// Headers Cloudflare adds that would reveal the caller (IP, location) to the tab
const STRIP_HEADERS = /^(cf-|x-forwarded-|x-real-ip$|true-client-ip$|cdn-loop$)/

function newId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return Array.from(bytes, (b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('')
}

const app = new Hono<{ Bindings: Env }>()

// A tab connects here. It may ask to keep its previous id (after a reload); otherwise it gets a new one.
app.get('/tunnel', async (c) => {
  if (c.req.header('upgrade') !== 'websocket') return c.text('Expected a WebSocket upgrade\n', 426)
  const requested = c.req.query('id')
  const id = requested && ID_RE.test(requested) ? requested : newId()
  const url = new URL(c.req.url)
  url.searchParams.set('id', id)
  return c.env.TABS.get(c.env.TABS.idFromName(id)).fetch(new Request(url, c.req.raw))
})

// curl hits /s/<id>/<path>, which is forwarded to that tab as /<path>
const forward = async (c: any) => {
  const id = c.req.param('id')
  if (!ID_RE.test(id)) return c.text('Unknown tab id\n', 404)
  if (Number(c.req.header('content-length') ?? 0) > MAX_BODY_BYTES) return c.text('Body too large\n', 413)
  return c.env.TABS.get(c.env.TABS.idFromName(id)).fetch(c.req.raw)
}
app.all('/s/:id', forward)
app.all('/s/:id/*', forward)

export default app

export class TabTunnel extends DurableObject<Env> {
  /** Requests waiting for the tab to answer. Only exists while a request is in flight. */
  pending = new Map<string, (res: Response) => void>()

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    // Keepalive pings from the tab are answered without waking this object
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
  }

  async fetch(req: Request) {
    const url = new URL(req.url)
    return url.pathname === '/tunnel' ? this.acceptTab(url) : this.forward(req, url)
  }

  acceptTab(url: URL) {
    const id = url.searchParams.get('id')!
    for (const old of this.ctx.getWebSockets()) {
      old.send(JSON.stringify({ type: 'replaced' }))
      old.close(1000, 'replaced by a newer tab')
    }
    const { 0: client, 1: server } = new WebSocketPair()
    this.ctx.acceptWebSocket(server)
    server.send(JSON.stringify({ type: 'info', id, tunnelUrl: `${url.origin}/s/${id}` }))
    return new Response(null, { status: 101, webSocket: client })
  }

  async forward(req: Request, url: URL) {
    const [tab] = this.ctx.getWebSockets()
    if (!tab) {
      return new Response(`No browser tab is connected for this URL. Open ${url.origin} to start one.\n`, {
        status: 503,
      })
    }
    const body = req.body ? new Uint8Array(await req.arrayBuffer()) : null
    if (body && body.byteLength > MAX_BODY_BYTES) return new Response('Body too large\n', { status: 413 })

    const id = crypto.randomUUID()
    const path = url.pathname.replace(/^\/s\/[^/]+/, '') || '/'
    const response = new Promise<Response>((resolve) => {
      this.pending.set(id, resolve)
      setTimeout(() => {
        if (this.pending.delete(id)) resolve(new Response('The browser tab did not answer in time.\n', { status: 504 }))
      }, TIMEOUT_MS)
    })
    tab.send(
      JSON.stringify({
        id,
        method: req.method,
        url: `${url.origin}${path}${url.search}`,
        headers: [...req.headers].filter(([name]) => !STRIP_HEADERS.test(name)),
        body: body && body.byteLength ? body.toBase64() : null,
      }),
    )
    return response
  }

  webSocketMessage(_ws: WebSocket, data: string | ArrayBuffer) {
    const msg = JSON.parse(String(data))
    const resolve = this.pending.get(msg.id)
    if (!resolve) return
    this.pending.delete(msg.id)
    const noBody = msg.status === 204 || msg.status === 304
    resolve(new Response(noBody ? null : Uint8Array.fromBase64(msg.body), { status: msg.status, headers: msg.headers }))
  }
}
