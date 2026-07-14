import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const path = new URL('../mcp-manifest.json', import.meta.url)
const before = await readFile(path, 'utf8')
const result = spawnSync(process.execPath, [fileURLToPath(new URL('./generate-manifest.mjs', import.meta.url))], {
  stdio: 'inherit',
})
if (result.status !== 0) process.exit(result.status ?? 1)
const after = await readFile(path, 'utf8')
if (before !== after) {
  console.error('mcp-manifest.json is stale; run pnpm generate:manifest')
  process.exit(1)
}
