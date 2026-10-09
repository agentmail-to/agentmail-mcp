import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'

process.env.AGENTMAIL_MCP_NO_LISTEN = '1'
process.env.CLERK_PUBLISHABLE_KEY ||= 'pk_test_contract'
process.env.CLERK_SECRET_KEY ||= 'sk_test_contract'

// The catalog exactly as served: the same raw tools/list result the protocol
// fast path answers with, taken from the full SDK path. Not through an SDK
// client, which would drop any field newer than the client.
const { loadProtocolSnapshot } = await import('../packages/server/build/index.js')
const { tools } = JSON.parse((await loadProtocolSnapshot()).toolsListJson)

const oauthToolNames = new Set(['list_organizations', 'select_organization'])
// Historical flag, now always empty: credential requirements are the API's to
// enforce, so no tool is refused client-side by auth kind. The key stays in the
// manifest for contract continuity.
const apiKeyOnlyToolNames = new Set()
const contract = tools.map((tool) => ({
  ...tool,
  oauthOnly: oauthToolNames.has(tool.name),
  apiKeyOnly: apiKeyOnlyToolNames.has(tool.name),
}))
const digest = createHash('sha256').update(JSON.stringify(contract)).digest('hex')
const manifest = {
  schemaVersion: 1,
  server: 'to.agentmail/agentmail',
  endpoint: 'https://mcp.agentmail.to/mcp',
  digest: `sha256:${digest}`,
  tools: contract,
}

await writeFile(new URL('../mcp-manifest.json', import.meta.url), `${JSON.stringify(manifest, null, 2)}\n`)
