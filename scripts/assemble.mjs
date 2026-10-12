// Collects everything the browser needs into dist/public, the folder that both the
// local relay and Cloudflare serve as static files.
import { cpSync, mkdirSync, readdirSync, rmSync } from 'node:fs'

const out = 'dist/public'
rmSync(out, { recursive: true, force: true })
mkdirSync(`${out}/wasm`, { recursive: true })

cpSync('web/index.html', `${out}/index.html`)
cpSync('dist/web', out, { recursive: true })
for (const file of readdirSync('dist/transpiled')) {
  if (file.endsWith('.wasm')) cpSync(`dist/transpiled/${file}`, `${out}/wasm/${file}`)
}

console.log(`assembled ${out}: ${readdirSync(out, { recursive: true }).join(', ')}`)
