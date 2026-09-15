import assert from 'node:assert/strict'
import test from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

process.env.AGENTMAIL_MCP_NO_LISTEN = '1'
process.env.AGENTMAIL_API_URL = 'https://api.example.test'

const { createMcpServer, getThreadPage } = await import('../packages/server/build/index.js')

/** Call one tool through a real MCP client against a per-test server, with
 * global fetch stubbed — exercising the registration wrapper in index.ts. Teardown runs in finally so a failing assertion or
 * a rejected callTool (e.g. client-side argument validation) cannot leak the
 * server/transport pair or the fetch stub into later tests. */
async function callTool(auth, name, args, fetchStub) {
  const calls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    return fetchStub(url, init)
  }
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const server = createMcpServer(auth)
  const client = new Client({ name: 'get-thread-test', version: '1.0.0' })
  try {
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    const result = await client.callTool({ name, arguments: args })
    return { result, calls }
  } finally {
    globalThis.fetch = realFetch
    await client.close().catch(() => {})
    await server.close().catch(() => {})
  }
}

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

const apiKeyAuth = { kind: 'apiKey', apiKey: 'am_test_key' }

test('get_thread forwards message pagination and republishes its cursor', async () => {
  const timestamp = '2026-09-10T00:00:00.000Z'
  const { result, calls } = await callTool(
    apiKeyAuth,
    'get_thread',
    { inboxId: 'agent@example.com', threadId: 'thread-1', limit: 25, pageToken: 'older-page' },
    () =>
      json({
        inbox_id: 'agent@example.com',
        thread_id: 'thread-1',
        labels: [],
        timestamp,
        senders: [],
        recipients: [],
        last_message_id: 'message-1',
        message_count: 200,
        size: 1,
        updated_at: timestamp,
        created_at: timestamp,
        messages: [],
        count: 0,
        limit: 25,
        next_page_token: 'legacy-cursor',
        nextPageToken: 'next-older-page',
      }),
  )

  const url = new URL(calls[0].url)
  assert.equal(url.pathname, '/v0/inboxes/agent%40example.com/threads/thread-1')
  assert.equal(url.searchParams.get('limit'), '25')
  assert.equal(url.searchParams.get('page_token'), 'older-page')
  assert.equal(result.isError, false)
  assert.equal(result.structuredContent.count, 0)
  assert.equal(result.structuredContent.limit, 25)
  assert.equal(result.structuredContent.nextPageToken, 'next-older-page')
  assert.equal('next_page_token' in result.structuredContent, false)
})

test('get_thread uses Fern request and request-options slots after SDK regeneration', async () => {
  const calls = []
  const get = async function regeneratedGet(inboxId, threadId, request = {}, requestOptions) {
    calls.push({ inboxId, threadId, request, requestOptions })
    return {}
  }
  const client = { inboxes: { threads: { get } } }
  const signal = AbortSignal.abort()

  await getThreadPage(
    client,
    { inboxId: 'agent@example.com', threadId: 'thread-1', limit: 25, pageToken: 'older-page' },
    signal,
  )

  assert.deepEqual(calls, [
    {
      inboxId: 'agent@example.com',
      threadId: 'thread-1',
      request: { limit: 25, pageToken: 'older-page' },
      requestOptions: { abortSignal: signal },
    },
  ])
})
