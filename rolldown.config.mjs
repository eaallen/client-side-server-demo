import { defineConfig } from 'rolldown'

// Bundles the Hono app so `jco componentize` can turn it into a wasm component
export default defineConfig({
  input: 'src/component.ts',
  external: [/^wasi:.*/, /^demo:.*/],
  output: {
    file: 'dist/component.js',
    format: 'esm',
  },
})
