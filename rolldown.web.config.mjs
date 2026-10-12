import { defineConfig } from 'rolldown'

// Bundles the page scripts: main.ts (plus the jco-transpiled component and WASI browser
// shims) and tictactoe.ts, which is kept separate so it has no access to the server
export default defineConfig({
  input: {
    main: 'web/main.ts',
    tictactoe: 'web/tictactoe.ts',
  },
  platform: 'browser',
  // only referenced by jco's Node.js fallback loader, never reached in the browser
  external: [/^node:/],
  // jco's transpiled output starts with a harmless "use components" directive
  onLog(level, log, handler) {
    if (log.code !== 'MODULE_LEVEL_DIRECTIVE') handler(level, log)
  },
  output: {
    dir: 'dist/web',
    entryFileNames: '[name].js',
    format: 'esm',
    minify: true,
    sourcemap: true,
  },
})
