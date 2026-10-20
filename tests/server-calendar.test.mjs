import assert from 'node:assert/strict'
import test from 'node:test'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'

process.env.AGENTMAIL_MCP_NO_LISTEN = '1'
process.env.AGENTMAIL_API_URL = 'https://api.example.test'

const { createMcpServer } = await import('../packages/server/build/index.js')

test('delete_event strips the internal deletionId from its result', async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ deletion_id: 'deletion-1', operation_id: 'operation-1' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const server = createMcpServer({ kind: 'apiKey', apiKey: 'am_test_key' })
  const client = new Client({ name: 'calendar-test', version: '1.0.0' })
  try {
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    await client.listTools()
    const result = await client.callTool({
      name: 'delete_event',
      arguments: { inboxId: 'agent@example.com', eventId: '0f0e5d4c-1b2a-4c3d-8e9f-a0b1c2d3e4f5' },
    })
    assert.equal(result.isError, false)
    assert.deepEqual(result.structuredContent, { success: true })
    assert.deepEqual(JSON.parse(result.content[0].text), { success: true })
  } finally {
    globalThis.fetch = realFetch
    await client.close().catch(() => {})
    await server.close().catch(() => {})
  }
})
