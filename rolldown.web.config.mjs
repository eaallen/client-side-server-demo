import { defineConfig } from 'rolldown'

// Bundles the page script (plus the jco-transpiled component and WASI browser shims)
export default defineConfig({
  input: 'web/main.ts',
  platform: 'browser',
  // only referenced by jco's Node.js fallback loader, never reached in the browser
  external: [/^node:/],
  // jco's transpiled output starts with a harmless "use components" directive
  onLog(level, log, handler) {
    if (log.code !== 'MODULE_LEVEL_DIRECTIVE') handler(level, log)
  },
  output: {
    file: 'dist/web/main.js',
    format: 'esm',
  },
})
