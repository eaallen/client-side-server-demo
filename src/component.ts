import { Hono } from 'hono'
import { fire } from '@bytecodealliance/jco-std/wasi/0.2.12/http/adapters/hono/server'
// Implemented by plain JS on the web page (see web/main.ts), declared in wit/component.wit
import { log, echo, setColor, readNote, describeUi, interact } from 'demo:browser-server/page'

const app = new Hono()

const UI_ROUTES = [
  'GET  /ui               lists every clickable / typeable element on the page',
  'POST /ui/:ref/click    clicks an element, e.g. /ui/e3/click',
  'POST /ui/:ref/fill     types the request body into a text field',
]

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
      ...UI_ROUTES.map((line) => `  ${line}`),
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

// Drive the page's UI the way a person would: discover elements, then click or type
// The instructions are written for an AI (or a person) that only sees this response
app.get('/ui', (c) => {
  const elements = describeUi()
  const clickable = elements.find((e) => !e.disabled && e.role === 'button')
  const fillable = elements.find((e) => !e.disabled && e.actions.includes('fill'))
  return c.json({
    instructions: {
      summary:
        'These are the interactive elements on the web page hosting this server. To change the page, ' +
        "send a request using an element's ref. Paths are relative to the URL you used for /ui.",
      routes: UI_ROUTES,
      examples: [
        clickable && `POST /ui/${clickable.ref}/click   clicks "${clickable.name}"`,
        fillable && `POST /ui/${fillable.ref}/fill    with a plain-text body, replaces the text in "${fillable.name}"`,
      ].filter(Boolean),
      rules: [
        "Only use an action listed in the element's `actions`; /fill only works on text fields.",
        'Disabled elements cannot be clicked, the same as for a person using the page.',
        'Each action returns { ok: true, element } with the updated element, or { ok: false, error } with status 400.',
        'Refs reset when the page reloads. If a ref is not found, GET /ui again.',
      ],
    },
    elements,
  })
})

app.post('/ui/:ref/click', (c) => runAction(c.req.param('ref'), { tag: 'click' }))

app.post('/ui/:ref/fill', async (c) => runAction(c.req.param('ref'), { tag: 'fill', val: await c.req.text() }))

function runAction(ref: string, action: Parameters<typeof interact>[1]) {
  try {
    return Response.json({ ok: true, element: interact(ref, action) })
  } catch (err) {
    // jco turns an `err` result from the page into a thrown error with the message as payload
    const message = (err as { payload?: string }).payload ?? String(err)
    return Response.json({ ok: false, error: message }, { status: 400 })
  }
}

fire(app)

export { incomingHandler } from '@bytecodealliance/jco-std/wasi/0.2.12/http/adapters/hono/server'
