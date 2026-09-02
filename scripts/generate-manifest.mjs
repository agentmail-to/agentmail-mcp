import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

process.env.AGENTMAIL_MCP_NO_LISTEN = '1'
process.env.CLERK_PUBLISHABLE_KEY ||= 'pk_test_contract'
process.env.CLERK_SECRET_KEY ||= 'sk_test_contract'

const { createMcpServer } = await import('../packages/server/build/index.js')
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
const server = createMcpServer({ kind: 'apiKey', apiKey: 'contract-only' })
const client = new Client({ name: 'manifest-generator', version: '1.0.0' })

await server.connect(serverTransport)
await client.connect(clientTransport)
const { tools } = await client.listTools()
await client.close()
await server.close()

const oauthToolNames = new Set(['list_organizations', 'select_organization'])
// The inverse restriction: the API re-authenticates these tools' raw bearer as
// an API key, so OAuth sessions get a refusal. Derived from the same filtered
// list the runtime registers (a hardcoded name list — or the unfiltered
// PROVIDER_TOOLS — could silently disagree with the server's actual behavior,
// e.g. once the toolkit ships its own version of a tool and the filter retires
// ours along with its apiKeyOnly gate).
const { ACTIVE_PROVIDER_TOOLS } = await import('../packages/server/build/index.js')
const apiKeyOnlyToolNames = new Set(
  ACTIVE_PROVIDER_TOOLS.filter((tool) => tool.apiKeyOnly).map((tool) => tool.name),
)
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
