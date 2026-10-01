import assert from 'node:assert/strict'
import test from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

process.env.AGENTMAIL_MCP_NO_LISTEN = '1'

const { createMcpServer, SERVER_INSTRUCTIONS } = await import('../packages/server/build/index.js')

async function connect(t, auth) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const server = createMcpServer(auth)
  const client = new Client({ name: 'instructions-test', version: '1.0.0' })
  t.after(async () => {
    await client.close().catch(() => {})
    await server.close().catch(() => {})
  })
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  return client
}

test('initialize returns the server instructions', async (t) => {
  const client = await connect(t, { kind: 'apiKey', apiKey: 'am_test_key' })
  assert.equal(client.getInstructions(), SERVER_INSTRUCTIONS)
  assert.match(SERVER_INSTRUCTIONS, /AgentID/)
})

// The instructions name tools by hand; a renamed or dropped tool would leave
// the model pointed at something that no longer exists.
test('every tool the instructions name is in the catalog', async (t) => {
  const client = await connect(t, { kind: 'apiKey', apiKey: 'am_test_key' })
  const { tools } = await client.listTools()
  const catalog = new Set(tools.map((tool) => tool.name))
  const named = new Set(SERVER_INSTRUCTIONS.match(/\b[a-z]+(?:_[a-z]+)+\b/g))
  assert.ok(named.has('connect_app'))
  for (const name of named) assert.ok(catalog.has(name), `instructions name unknown tool ${name}`)
})

test('the instructions stay short enough for clients that truncate', () => {
  assert.ok(SERVER_INSTRUCTIONS.length <= 2000, `instructions are ${SERVER_INSTRUCTIONS.length} chars`)
})
