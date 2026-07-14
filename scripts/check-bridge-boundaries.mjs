import { readFile, readdir } from 'node:fs/promises'
import { extname, join } from 'node:path'

const root = new URL('..', import.meta.url)
const npmPackage = JSON.parse(
  await readFile(new URL('packages/npm-stdio-bridge/package.json', root), 'utf8'),
)
for (const dependency of ['agentmail', 'agentmail-toolkit']) {
  if (npmPackage.dependencies?.[dependency] || npmPackage.devDependencies?.[dependency]) {
    throw new Error(`npm bridge must not depend on ${dependency}`)
  }
}

const forbidden = /AgentMailClient|AgentMailToolkit|agentmail-toolkit|(?:^|["'`])\/v0\/|inputSchema|outputSchema/
for (const directory of [
  new URL('packages/npm-stdio-bridge/src', root),
  new URL('python/stdio-bridge/src', root),
]) {
  for (const file of await files(directory.pathname)) {
    const source = await readFile(file, 'utf8')
    if (forbidden.test(source)) throw new Error(`bridge business logic/schema found in ${file}`)
  }
}

async function files(directory) {
  const found = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) found.push(...(await files(path)))
    else if (['.js', '.py', '.ts'].includes(extname(entry.name))) found.push(path)
  }
  return found
}
