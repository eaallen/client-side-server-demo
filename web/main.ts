// Runs in the browser. Loads the Hono WebAssembly component, gives it access to
// the page (the `demo:browser-server/page` WIT interface), and connects it to the
// local relay so `curl` on your machine can reach it.
import { WASIShim } from '@bytecodealliance/preview2-shim/instantiation'
import { InMemoryHttpClient } from '@bytecodealliance/preview2-shim/http'
import { instantiate } from '../dist/transpiled/server.js'
import { describeUi, interact, type UiElement } from './ui-automation.ts'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

const logEl = $<HTMLOListElement>('log')
const echoEl = $<HTMLDivElement>('echo')
const noteEl = $<HTMLTextAreaElement>('note')
const serverStatus = $<HTMLSpanElement>('server-status')
const tunnelStatus = $<HTMLSpanElement>('tunnel-status')

type LogKind = 'info' | 'stdout' | 'stderr' | 'request' | 'page'

function addLog(kind: LogKind, text: string) {
  const li = document.createElement('li')
  li.className = `log-${kind}`
  const time = document.createElement('time')
  time.textContent = new Date().toLocaleTimeString()
  const tag = document.createElement('span')
  tag.className = 'tag'
  tag.textContent = kind
  const msg = document.createElement('span')
  msg.className = 'msg'
  msg.textContent = text
  li.append(time, tag, msg)
  logEl.prepend(li)
  while (logEl.children.length > 200) logEl.lastChild!.remove()
}

function setStatus(el: HTMLElement, state: 'pending' | 'ok' | 'error', text: string) {
  el.dataset.state = state
  el.textContent = text
}

// --- 1. The page interface: plain JS functions the wasm server can call --------

const page = {
  log(message: string) {
    addLog('page', message)
  },
  echo(text: string) {
    echoEl.textContent = text
    echoEl.classList.remove('flash')
    void echoEl.offsetWidth // restart the CSS animation
    echoEl.classList.add('flash')
  },
  setColor(color: string) {
    if (!CSS.supports('color', color)) {
      addLog('page', `"${color}" is not a valid CSS color`)
      return false
    }
    document.documentElement.style.setProperty('--accent', color)
    addLog('page', `accent color set to ${color}`)
    return true
  },
  readNote() {
    return noteEl.value
  },
  describeUi() {
    const elements = describeUi()
    addLog('page', `described ${elements.length} interactive elements`)
    return elements
  },
  interact(ref: string, action: Parameters<typeof interact>[1]) {
    const result = interact(ref, action)
    const what = action.tag === 'fill' ? `fill ${ref} with ${JSON.stringify(action.val)}` : `click ${ref}`
    const outcome = result.tag === 'ok' ? `"${(result.val as UiElement).name}"` : `failed: ${result.val}`
    addLog('page', `${what} → ${outcome}`)
    return result
  },
}

// Route the component's stdout/stderr (console.log / console.error in Hono) to the page
function lineWriter(kind: LogKind) {
  const decoder = new TextDecoder()
  let pending = ''
  const flush = () => {
    pending += decoder.decode()
    if (pending) addLog(kind, pending)
    pending = ''
  }
  return {
    write(bytes: Uint8Array) {
      pending += decoder.decode(bytes, { stream: true })
      const lines = pending.split('\n')
      pending = lines.pop()!
      for (const line of lines) if (line) addLog(kind, line)
    },
    flush,
    blockingFlush: flush,
  }
}

// --- 2. Start the server: instantiate the wasm component in this tab ------------

async function startServer() {
  setStatus(serverStatus, 'pending', 'loading wasm…')
  const started = performance.now()
  const wasi = new WASIShim({ stdout: lineWriter('stdout'), stderr: lineWriter('stderr') })
  const component = await instantiate(
    (name) => WebAssembly.compileStreaming(fetch(`/wasm/${name}`)),
    { ...wasi.getImportObject(), 'demo:browser-server/page': page } as any,
  )
  const ms = Math.round(performance.now() - started)
  setStatus(serverStatus, 'ok', `running (${ms} ms to start)`)
  addLog('info', `Hono wasm server started in ${ms} ms`)
  // A fetch()-style client that calls the component's wasi:http/incoming-handler directly
  const client = new InMemoryHttpClient(component.incomingHandler)
  // The server can click buttons on this page, and some of those buttons call the server.
  // The wasm can't be re-entered in the middle of a request, so calls wait their turn.
  let queue: Promise<unknown> = Promise.resolve()
  return {
    fetch(request: Request) {
      const response = queue.then(() => client.fetch(request))
      queue = response.catch(() => {})
      return response
    },
  }
}

type Server = Awaited<ReturnType<typeof startServer>>

// --- 3. Connect to the relay so requests from curl reach this tab ----------------

type TunnelRequest = { id: string; method: string; url: string; headers: [string, string][]; body: string | null }

// In production every tab gets its own public URL; remember it so a reload keeps it
const ID_KEY = 'tunnel-id'
const storage = {
  get: () => { try { return sessionStorage.getItem(ID_KEY) } catch { return null } },
  set: (id: string) => { try { sessionStorage.setItem(ID_KEY, id) } catch {} },
}

function connectTunnel(server: Server) {
  const id = storage.get()
  const ws = new WebSocket(
    `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/tunnel${id ? `?id=${id}` : ''}`,
  )
  // Idle WebSockets get dropped by proxies, so ping every 30s
  const keepalive = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send('ping'), 30_000)

  ws.onopen = () => setStatus(tunnelStatus, 'ok', 'connected')
  ws.onclose = () => {
    clearInterval(keepalive)
    setStatus(tunnelStatus, 'error', 'disconnected, retrying…')
    setTimeout(() => connectTunnel(server), 1000)
  }
  ws.onmessage = async (event) => {
    if (event.data === 'pong') return
    const msg = JSON.parse(event.data)
    if (msg.type === 'info') {
      if (msg.id) storage.set(msg.id)
      $('curl-base').textContent = msg.tunnelUrl
      document.querySelectorAll('[data-curl]').forEach((el) => {
        el.textContent = (el as HTMLElement).dataset.curl!.replaceAll('$URL', msg.tunnelUrl)
      })
      return
    }
    if (msg.type === 'replaced') {
      setStatus(tunnelStatus, 'error', 'another tab took over')
      ws.onclose = () => clearInterval(keepalive)
      return
    }
    const req = msg as TunnelRequest
    const started = performance.now()
    let res: Response
    try {
      res = await server.fetch(
        new Request(req.url, {
          method: req.method,
          headers: req.headers,
          body: req.body === null ? null : Uint8Array.fromBase64(req.body),
        }),
      )
    } catch (err) {
      res = new Response(`browser error: ${err}\n`, { status: 500 })
    }
    const body = new Uint8Array(await res.arrayBuffer())
    const path = new URL(req.url).pathname
    addLog('request', `relay ${req.method} ${path} → ${res.status} (${(performance.now() - started).toFixed(1)} ms)`)
    ws.send(
      JSON.stringify({
        id: req.id,
        status: res.status,
        headers: [...res.headers],
        body: body.toBase64(),
      }),
    )
  }
}

// --- Page buttons: call the same server in-page, no network involved --------------

function wireButtons(server: Server) {
  document.querySelectorAll<HTMLButtonElement>('[data-try]').forEach((btn) => {
    btn.disabled = false
    btn.onclick = async () => {
      const [method, path] = btn.dataset.try!.split(' ')
      const body = method === 'POST' ? `hello from the page at ${new Date().toLocaleTimeString()}` : null
      const res = await server.fetch(new Request(`http://in-page${path}`, { method, body }))
      addLog('request', `page ${method} ${path} → ${res.status}: ${(await res.text()).trim()}`)
    }
  })
}

startServer()
  .then((server) => {
    wireButtons(server)
    connectTunnel(server)
  })
  .catch((err) => {
    setStatus(serverStatus, 'error', 'failed to start')
    addLog('stderr', String(err?.stack ?? err))
  })
