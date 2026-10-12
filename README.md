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
curl localhost:8000/hello
```

```bash
curl -d 'hi from my terminal' localhost:8000/echo
```

```bash
curl -X PUT localhost:8000/color/tomato
```

```bash
curl localhost:8000/note
```

```bash
curl 'localhost:8000/log?msg=hello+page'
```

Watch the page: the echo panel updates, the accent color changes, and the activity log shows
each request plus every `console.log` from inside the wasm.

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
   component's stdout/stderr are also piped into the page's activity log.

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
| `GET /` | Lists the routes |
| `GET /hello` | `{"message":"Hello from WebAssembly!"}` (same as the Hono docs) |
| `POST /echo` | Shows the body in the page's echo panel and echoes it back |
| `PUT /color/:color` | Sets the page's accent color; `400` if it isn't a valid CSS color |
| `GET /note` | Returns whatever is typed in the page's note box |
| `GET /log?msg=…` | Writes a line to the page's activity log |

## Build pipeline

| Script | Step |
| --- | --- |
| `build:component` | `rolldown -c` bundles `src/component.ts`, then `jco componentize` builds `dist/component.wasm` |
| `build:transpile` | `jco transpile --instantiation async` emits browser-loadable JS + core wasm into `dist/transpiled/` |
| `build:web` | Rolldown bundles `web/main.ts` (and the WASI browser shims) into `dist/web/main.js` |
| `start` | Starts the relay: page on `:3000`, curl endpoint on `:8000` (override with `PAGE_PORT` / `TUNNEL_PORT`) |
| `typecheck` | Generates TS types from the WIT with `jco guest-types`, then runs `tsc` (after a build) |

## Differences from the Hono guide

- **WASI 0.2.12 instead of 0.2.6.** The guide fetches WIT with `wkg wit fetch`. To keep the setup
  npm-only, `wit/deps/` vendors the WASI 0.2.12 WIT that ships with jco, and the app uses jco-std's
  matching `wasi/0.2.12` Hono adapter.
- **A custom WIT import.** The world also imports `demo:browser-server/page`, so the component
  can't run under `jco serve` (it has nothing to provide that interface). It needs the page.
- The component is about 13 MB because it embeds the StarlingMonkey JS engine. It loads in well
  under a second from localhost.
