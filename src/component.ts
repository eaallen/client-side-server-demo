import { Hono } from 'hono'
import { fire } from '@bytecodealliance/jco-std/wasi/0.2.12/http/adapters/hono/server'
// Implemented by plain JS on the web page (see web/main.ts), declared in wit/component.wit
import { log, echo, setColor, readNote } from 'demo:browser-server/page'

const app = new Hono()

app.use(async (c, next) => {
  // console.log inside the wasm goes to WASI stdout, which the page pipes into its log
  console.log(`--> ${c.req.method} ${c.req.path}`)
  await next()
  console.log(`<-- ${c.res.status}`)
})

app.get('/', (c) =>
  c.text(
    [
      'Hello from a Hono server compiled to WebAssembly, running in a browser tab!',
      '',
      'Try:',
      '  GET  /hello            JSON response (same as the Hono WASI docs)',
      '  POST /echo             body is shown on the web page and echoed back',
      '  PUT  /color/:color     changes the page accent color, e.g. /color/tomato',
      '  GET  /note             reads the note box on the page',
      '  GET  /log?msg=hi       writes a line to the page activity log',
      '',
    ].join('\n'),
  ),
)

app.get('/hello', (c) => c.json({ message: 'Hello from WebAssembly!' }))

app.post('/echo', async (c) => {
  const text = await c.req.text()
  echo(text)
  log(`echoed ${text.length} chars`)
  return c.text(`${text}\n`)
})

app.on(['GET', 'PUT'], '/color/:color', (c) => {
  const color = c.req.param('color')
  const ok = setColor(color)
  return c.json({ ok, color }, ok ? 200 : 400)
})

app.get('/note', (c) => c.json({ note: readNote() }))

app.get('/log', (c) => {
  const msg = c.req.query('msg') ?? '(empty)'
  log(msg)
  return c.json({ logged: msg })
})

fire(app)

export { incomingHandler } from '@bytecodealliance/jco-std/wasi/0.2.12/http/adapters/hono/server'
