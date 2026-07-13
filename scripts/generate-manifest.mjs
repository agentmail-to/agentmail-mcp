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
const contract = tools.map((tool) => ({ ...tool, oauthOnly: oauthToolNames.has(tool.name) }))
const digest = createHash('sha256').update(JSON.stringify(contract)).digest('hex')
const manifest = {
  schemaVersion: 1,
  server: 'to.agentmail/agentmail',
  endpoint: 'https://mcp.agentmail.to/mcp',
  digest: `sha256:${digest}`,
  tools: contract,
}

await writeFile(new URL('../mcp-manifest.json', import.meta.url), `${JSON.stringify(manifest, null, 2)}\n`)
