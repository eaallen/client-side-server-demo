# Hono server in a browser tab

A [Hono](https://hono.dev) app compiled to a WebAssembly (WASI) component, following
Hono's [WebAssembly w/ WASI guide](https://hono.dev/docs/getting-started/webassembly-wasi),
then run **inside a web page** instead of with `jco serve`. You can `curl` it from your terminal,
and its routes can drive ordinary JavaScript on the page that hosts it.

## Run it

Requires Node 22+ and a recent Chrome, Firefox or Safari.

```bash
npm install
```

```bash
npm run demo
```

Open <http://localhost:3000>, then from a terminal:

```bash
curl localhost:8000/help
```

```bash
curl localhost:8000/hello
```

```bash
curl -G --data-urlencode 'text=hi from my terminal' localhost:8000/echo
```

```bash
curl localhost:8000/color/tomato
```

```bash
curl localhost:8000/note
```

```bash
curl 'localhost:8000/log?msg=hello+page'
```

Watch the page: the echo panel updates, the accent color changes, and the activity log shows
each request plus every `console.log` from inside the wasm.

## Production (Cloudflare)

Live at **<https://client-side-server-demo.cotc.workers.dev>**. Open it and each tab gets its own
public URL, e.g. `https://client-side-server-demo.cotc.workers.dev/s/<tab-id>/hello`, shown on the page.

```bash
npm run cf:dev
```

```bash
npm run deploy
```

`cf:dev` runs the production setup locally on <http://localhost:8787>. `deploy` builds and runs
`wrangler deploy` (log in once with `npx wrangler login`).

In production, [cloudflare/worker.ts](cloudflare/worker.ts) replaces the local relay:

- **Static assets.** `dist/public/` (page, minified `main.js`, wasm) is served by Workers static
  assets. Cloudflare compresses the 12.6 MB wasm with brotli on the fly.
- **One Durable Object per tab.** A tab connects to `/tunnel` and gets a random 16-character id. The
  `TabTunnel` Durable Object for that id holds the tab's WebSocket, and requests to `/s/<id>/*` are
  forwarded to it. The tab keeps its id in `sessionStorage`, so a reload keeps the same URL.
- **Limits.** 1 MB request bodies, 30 s timeout, `503` when no tab is connected. Cloudflare's
  `cf-*` and `x-forwarded-*` headers are stripped, so the tab never sees the caller's IP.
- **Keepalive.** The tab pings every 30 s. The Durable Object auto-replies without waking up
  (WebSocket hibernation), so idle tabs cost nothing.

Anyone who knows a tab's URL can send it requests. That's the point of the demo, but don't put
anything sensitive behind it.

The page also has a **Prompt for an AI** box with a Copy button. It explains, with this tab's real URL
filled in, that the page is used through HTTP requests (`/help`, `/ui`, click and fill), not a
browser, so you can paste it into any AI chat that can run `curl`.

## What the demo shows

1. **A server running in the browser.** `src/component.ts` is a normal Hono app. It's built into
   `dist/component.wasm` exactly as in the Hono docs, then `jco transpile` turns that component into
   JS + core wasm that a browser can load. The page instantiates it with jco's browser WASI shims
   and calls its `wasi:http/incoming-handler` like a `fetch()` function.
2. **curl from your computer reaches it.** Browsers can't listen on a port, so `relay/server.mjs`
   does that part: it accepts HTTP on `:8000` and forwards each request over a WebSocket to the tab,
   which runs it through the wasm server and sends the response back. The relay never runs your
   Hono code.
3. **The server drives regular JS on the page.** `wit/component.wit` declares a `page` interface
   (`log`, `echo`, `set-color`, `read-note`) that the component imports. `web/main.ts` implements it
   with plain DOM code, so Hono handlers can call `echo(text)` or `readNote()` directly. The
   component's stdout/stderr are also piped into the page's activity log. With `describe-ui` and
   `interact`, the server can also find and use any button or text field on the page.

```
curl ──HTTP──▶ relay :8000 ──WebSocket──▶ browser tab
                                            │  web/main.ts
                                            ▼
                                   Hono (wasm component)
                                            │  imports demo:browser-server/page
                                            ▼
                                   DOM: echo panel, color, note, log
```

## Routes

| Route | What it does |
| --- | --- |
| `GET /help` (or `GET /`) | Lists the routes |
| `GET /hello` | `{"message":"Hello from WebAssembly!"}` (same as the Hono docs) |
| `GET /echo?text=…` | Shows the text in the page's echo panel and echoes it back (`POST` with a body also works) |
| `GET /color/:color` | Sets the page's accent color; `400` if it isn't a valid CSS color (`PUT` also works) |
| `GET /note` | Returns whatever is typed in the page's note box |
| `GET /log?msg=…` | Writes a line to the page's activity log |
| `GET /ui` | `{ instructions, elements }`: how to use the routes below (with examples using real refs), plus every visible clickable / typeable element with its `ref`, `role`, `name`, `section`, `value`, `disabled` and `actions` |
| `GET /ui/:ref/click` | Clicks that element like a user would; returns its updated description (`POST` also works) |
| `GET /ui/:ref/fill?text=…` | Types the text into a text field (`POST` with the text as the body also works) |

### Driving the UI from the server

`describe-ui` and `interact` in the WIT `page` interface give the server the same view of the
page a person has, roughly an accessibility tree, implemented in
[web/ui-automation.ts](web/ui-automation.ts):

```bash
curl localhost:8000/ui
```

```bash
curl localhost:8000/ui/e10/click
```

```bash
curl -G --data-urlencode 'text=typed by the server' localhost:8000/ui/e5/fill
```

- `GET /ui` returns `instructions` alongside `elements`, so an AI agent can learn the routes,
  ready-to-use examples and rules from that one response.
- Each element gets a ref like `e10` that stays the same while the element exists.
- `click` focuses the element and fires a real click, and `fill` sets the text and fires `input` and
  `change`. The element briefly gets an outline so you can watch it happen.
- There are no back doors into widgets. Tic-tac-toe ([web/tictactoe.ts](web/tictactoe.ts)) still
  exposes nothing, so the server plays it only by clicking cells, under the same rules as a person:
  filled cells and finished games are disabled, so those clicks fail with `400`.
- Clicking an in-page button like "GET /hello" makes the page call the server while the server is
  still handling the click. The wasm can't be re-entered, so [web/main.ts](web/main.ts) queues server
  calls and that request runs right after.

## Build pipeline

| Script | Step |
| --- | --- |
| `build:component` | `rolldown -c` bundles `src/component.ts`, then `jco componentize` builds `dist/component.wasm` |
| `build:transpile` | `jco transpile --instantiation async` emits browser-loadable JS + core wasm into `dist/transpiled/` |
| `build:web` | Rolldown bundles and minifies `web/main.ts` (and the WASI browser shims) into `dist/web/main.js` |
| `build:public` | Collects the page, `main.js` and the wasm files into `dist/public/` |
| `start` | Starts the local relay: page on `:3000`, curl endpoint on `:8000` (override with `PAGE_PORT` / `TUNNEL_PORT`) |
| `cf:dev` / `deploy` | Build, then `wrangler dev` / `wrangler deploy` |
| `typecheck` | Generates TS types from the WIT with `jco guest-types`, then runs `tsc` on the app, the page and the Worker (after a build) |

## Differences from the Hono guide

- **WASI 0.2.12 instead of 0.2.6.** The guide fetches WIT with `wkg wit fetch`. To keep the setup
  npm-only, `wit/deps/` vendors the WASI 0.2.12 WIT that ships with jco, and the app uses jco-std's
  matching `wasi/0.2.12` Hono adapter.
- **A custom WIT import.** The world also imports `demo:browser-server/page`, so the component
  can't run under `jco serve` (it has nothing to provide that interface). It needs the page.
- The component is about 13 MB (about 4 MB compressed) because it embeds the StarlingMonkey JS
  engine. `jco opt` only shaved 4% off it and added about 2 minutes to the build, so it isn't used.
