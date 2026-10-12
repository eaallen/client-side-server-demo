// Runs in the browser. Loads the Hono WebAssembly component, gives it access to
// the page (the `demo:browser-server/page` WIT interface), and connects it to the
// local relay so `curl` on your machine can reach it.
import { WASIShim } from '@bytecodealliance/preview2-shim/instantiation'
import { InMemoryHttpClient } from '@bytecodealliance/preview2-shim/http'
import { instantiate } from '../dist/transpiled/server.js'

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
  return new InMemoryHttpClient(component.incomingHandler)
}

// --- 3. Connect to the relay so requests from curl reach this tab ----------------

type TunnelRequest = { id: string; method: string; url: string; headers: [string, string][]; body: string | null }

function connectTunnel(server: InMemoryHttpClient) {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/tunnel`)

  ws.onopen = () => setStatus(tunnelStatus, 'ok', 'connected')
  ws.onclose = () => {
    setStatus(tunnelStatus, 'error', 'disconnected, retrying…')
    setTimeout(() => connectTunnel(server), 1000)
  }
  ws.onmessage = async (event) => {
    const msg = JSON.parse(event.data)
    if (msg.type === 'info') {
      $('curl-base').textContent = msg.tunnelUrl
      document.querySelectorAll('[data-curl]').forEach((el) => {
        el.textContent = (el as HTMLElement).dataset.curl!.replaceAll('$URL', msg.tunnelUrl)
      })
      return
    }
    if (msg.type === 'replaced') {
      setStatus(tunnelStatus, 'error', 'another tab took over')
      ws.onclose = null
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

function wireButtons(server: InMemoryHttpClient) {
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
