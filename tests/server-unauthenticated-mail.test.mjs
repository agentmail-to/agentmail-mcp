import assert from 'node:assert/strict'
import test from 'node:test'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'

// Mail that passed no sender authentication carries the restricted
// `unauthenticated` label, and the API returns it only when the call opts in
// with include_unauthenticated=true; a labels filter alone comes back empty
// (agentmail-api src/agentmail/helpers/search.ts, computeExcludedLabels).
// agentmail-toolkit 0.16 had no such argument, so MCP clients could not read
// the folder the console shows under Other → Unauthenticated.

process.env.AGENTMAIL_MCP_NO_LISTEN = '1'
process.env.AGENTMAIL_API_URL = 'https://api.example.test'

const { createMcpServer } = await import('../packages/server/build/index.js')

async function withClient(fn) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const server = createMcpServer({ kind: 'apiKey', apiKey: 'am_test_key' })
  const client = new Client({ name: 'unauthenticated-mail-test', version: '1.0.0' })
  try {
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    return await fn(client)
  } finally {
    await client.close().catch(() => {})
    await server.close().catch(() => {})
  }
}

/** Call one tool through a real MCP client, with global fetch stubbed. */
async function callTool(name, args, fetchStub) {
  const calls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    return fetchStub(url, init)
  }
  try {
    const result = await withClient((client) => client.callTool({ name, arguments: args }))
    return { result, calls }
  } finally {
    globalThis.fetch = realFetch
  }
}

const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

const timestamp = '2026-10-02T00:00:00.000Z'
// As the API sends it; SDK 0.5.46 passes authentication_results through in snake_case.
const unauthenticatedMessage = {
  inbox_id: 'agent@example.com',
  thread_id: 'thread-1',
  message_id: '<m1@sender.example>',
  labels: ['received', 'unauthenticated'],
  timestamp,
  from: 'sender@sender.example',
  to: ['agent@example.com'],
  subject: 'Hello',
  preview: 'Hello',
  text: 'Hello',
  size: 10,
  updated_at: timestamp,
  created_at: timestamp,
  authentication_results: { spf: 'none', dkim: 'none', dmarc: 'fail', dmarc_domain: 'sender.example', raw_header: 'x' },
}
const expectedVerdicts = { spf: 'none', dkim: 'none', dmarc: 'fail', dmarcDomain: 'sender.example' }

for (const tool of ['list_messages', 'list_threads']) {
  test(`${tool} forwards includeUnauthenticated, so the unauthenticated label filter can match`, async () => {
    const listKey = tool === 'list_messages' ? 'messages' : 'threads'
    const { result, calls } = await callTool(
      tool,
      { inboxId: 'agent@example.com', labels: ['unauthenticated'], includeUnauthenticated: true },
      () => json({ count: 0, [listKey]: [] })
    )
    assert.equal(result.isError, false, JSON.stringify(result))
    const url = new URL(calls[0].url)
    assert.equal(url.searchParams.get('include_unauthenticated'), 'true')
    // The SDK sends labels as JSON text, which the API parses (stringToArray).
    assert.deepEqual(JSON.parse(url.searchParams.get('labels')), ['unauthenticated'])
  })
}

test('the list tools advertise every restricted-label opt-in', async () => {
  const { tools } = await withClient((client) => client.listTools())
  for (const name of ['list_messages', 'list_threads']) {
    const properties = tools.find((tool) => tool.name === name).inputSchema.properties
    for (const flag of ['includeSpam', 'includeBlocked', 'includeUnauthenticated', 'includeTrash']) {
      assert.ok(flag in properties, `${name}.${flag}`)
    }
  }
})

test('get_message returns the recorded authentication verdicts', async () => {
  const { result } = await callTool('get_message', { inboxId: 'agent@example.com', messageId: '<m1@sender.example>' }, () =>
    json(unauthenticatedMessage)
  )
  assert.equal(result.isError, false, JSON.stringify(result))
  assert.deepEqual(result.structuredContent.authenticationResults, expectedVerdicts)
})

test('get_thread returns the same verdicts on each message as get_message', async () => {
  const { result } = await callTool('get_thread', { inboxId: 'agent@example.com', threadId: 'thread-1' }, () =>
    json({
      inbox_id: 'agent@example.com',
      thread_id: 'thread-1',
      labels: ['received', 'unauthenticated'],
      timestamp,
      senders: ['sender@sender.example'],
      recipients: ['agent@example.com'],
      last_message_id: '<m1@sender.example>',
      message_count: 1,
      size: 10,
      updated_at: timestamp,
      created_at: timestamp,
      messages: [unauthenticatedMessage],
      count: 1,
    })
  )
  assert.equal(result.isError, false, JSON.stringify(result))
  assert.deepEqual(result.structuredContent.messages[0].authenticationResults, expectedVerdicts)
  assert.equal('authentication_results' in result.structuredContent.messages[0], false)
})
