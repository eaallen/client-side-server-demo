import { Hono, type Context } from 'hono'
import { fire } from '@bytecodealliance/jco-std/wasi/0.2.12/http/adapters/hono/server'
// Implemented by plain JS on the web page (see web/main.ts), declared in wit/component.wit
import { log, echo, setColor, readNote, describeUi, interact } from 'demo:browser-server/page'

const app = new Hono()

const UI_ROUTES = [
  'GET  /ui               lists every clickable / typeable element on the page',
  'GET  /ui/:ref/click    clicks an element, e.g. /ui/e3/click (POST also works)',
  'GET  /ui/:ref/fill?text=...  types text into a text field (or POST the text as the body)',
]

app.use(async (c, next) => {
  // console.log inside the wasm goes to WASI stdout, which the page pipes into its log
  console.log(`--> ${c.req.method} ${c.req.path}`)
  await next()
  console.log(`<-- ${c.res.status}`)
})

const help = (c: Context) =>
  c.text(
    [
      'Hello from a Hono server compiled to WebAssembly, running in a browser tab!',
      '',
      'Try:',
      '  GET  /help             this message (same as GET /)',
      '  GET  /hello            JSON response (same as the Hono WASI docs)',
      '  GET  /echo?text=hi     shows the text on the web page and echoes it back (or POST a body)',
      '  GET  /color/:color     changes the page accent color, e.g. /color/tomato (PUT also works)',
      '  GET  /note             reads the note box on the page',
      '  GET  /log?msg=hi       writes a line to the page activity log',
      ...UI_ROUTES.map((line) => `  ${line}`),
      '',
    ].join('\n'),
  )

app.get('/', help)
app.get('/help', help)

app.get('/hello', (c) => c.json({ message: 'Hello from WebAssembly!' }))

// Everything works with plain GET (query string) so it can be used from a URL; POST/PUT also work
app.on(['GET', 'POST'], '/echo', async (c) => {
  const text = c.req.query('text') ?? (await c.req.text())
  echo(text)
  log(`echoed ${text.length} chars`)
  return c.text(`${text}\n`)
})

app.on(['GET', 'PUT', 'POST'], '/color/:color', (c) => {
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
        clickable && `GET /ui/${clickable.ref}/click   clicks "${clickable.name}"`,
        fillable && `GET /ui/${fillable.ref}/fill?text=hello   replaces the text in "${fillable.name}"`,
      ].filter(Boolean),
      rules: [
        "Only use an action listed in the element's `actions`; /fill only works on text fields.",
        'Every route works with GET. Put text in the query string and URL-encode it (curl -G --data-urlencode "text=a b" ...). POST also works.',
        'Disabled elements cannot be clicked, the same as for a person using the page.',
        'Each action returns { ok: true, element } with the updated element, or { ok: false, error } with status 400.',
        'Refs reset when the page reloads. If a ref is not found, GET /ui again.',
      ],
    },
    elements,
  })
})

app.on(['GET', 'POST'], '/ui/:ref/click', (c) => runAction(c.req.param('ref'), { tag: 'click' }))

app.on(['GET', 'POST'], '/ui/:ref/fill', async (c) =>
  runAction(c.req.param('ref'), { tag: 'fill', val: c.req.query('text') ?? (await c.req.text()) }),
)

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
