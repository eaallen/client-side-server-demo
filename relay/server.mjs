// A tiny local relay. Browsers can't listen on a TCP port, so this process does it
// for them: it accepts HTTP requests from curl on TUNNEL_PORT and forwards each one
// over a WebSocket to the browser tab, where the Hono WebAssembly server answers it.
//
//   curl ──HTTP──▶ relay :8000 ──WebSocket──▶ browser tab (Hono in wasm) ──▶ back to curl
//
// The relay never runs your Hono code. It also serves the demo page on PAGE_PORT.
// cloudflare/worker.ts is the production version of this file.
import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { createNodeWebSocket } from '@hono/node-ws'

const PAGE_PORT = Number(process.env.PAGE_PORT ?? 3000)
const TUNNEL_PORT = Number(process.env.TUNNEL_PORT ?? 8000)
const TIMEOUT_MS = 30_000
const TUNNEL_URL = `http://localhost:${TUNNEL_PORT}`

/** The browser tab currently hosting the server (latest tab to connect wins). */
let tab = null
/** Requests waiting for the browser to answer, by id. */
const pending = new Map()

// --- Page server: the demo website + the WebSocket the tab connects to ----------

const page = new Hono()
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app: page })

page.get(
  '/tunnel',
  upgradeWebSocket(() => ({
    onOpen(_event, ws) {
      if (tab) tab.send(JSON.stringify({ type: 'replaced' }))
      tab = ws
      ws.send(JSON.stringify({ type: 'info', tunnelUrl: TUNNEL_URL }))
      console.log('browser tab connected, curl away!')
    },
    onMessage(event, ws) {
      if (event.data === 'ping') return ws.send('pong')
      const msg = JSON.parse(String(event.data))
      const waiter = pending.get(msg.id)
      if (!waiter) return
      pending.delete(msg.id)
      waiter.resolve(
        new Response(msg.status === 204 || msg.status === 304 ? null : Buffer.from(msg.body, 'base64'), {
          status: msg.status,
          headers: msg.headers,
        }),
      )
    },
    onClose(_event, ws) {
      if (tab === ws) {
        tab = null
        console.log('browser tab disconnected')
      }
    },
  })),
)
page.use('*', serveStatic({ root: './dist/public' }))

const pageServer = serve({ fetch: page.fetch, port: PAGE_PORT })
injectWebSocket(pageServer)

// --- Tunnel server: every request is forwarded to the browser tab ---------------

const tunnel = new Hono()

tunnel.all('*', async (c) => {
  if (!tab) {
    return c.text(`No browser tab is hosting the server yet. Open http://localhost:${PAGE_PORT} first.\n`, 503)
  }
  const id = randomUUID()
  const body = c.req.raw.body ? Buffer.from(await c.req.arrayBuffer()) : null
  const response = new Promise((resolve, reject) => {
    pending.set(id, { resolve })
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error('timeout'))
    }, TIMEOUT_MS)
  })
  tab.send(
    JSON.stringify({
      id,
      method: c.req.method,
      url: c.req.url,
      headers: [...c.req.raw.headers],
      body: body && body.length ? body.toString('base64') : null,
    }),
  )
  try {
    return await response
  } catch {
    return c.text('The browser tab did not answer in time.\n', 504)
  }
})

serve({ fetch: tunnel.fetch, port: TUNNEL_PORT })

console.log(`
  1. Open the demo page:   http://localhost:${PAGE_PORT}
  2. Then from a terminal: curl ${TUNNEL_URL}/hello
`)
