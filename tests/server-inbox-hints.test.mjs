import assert from 'node:assert/strict'
import test from 'node:test'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'

process.env.AGENTMAIL_MCP_NO_LISTEN = '1'
process.env.AGENTMAIL_API_URL = 'https://api.example.test'

const { createMcpServer } = await import('../packages/server/build/index.js')

// The API's answers, by path. An agent sees them through the hosted server's tools.
async function withApi(answers, run) {
    const realFetch = globalThis.fetch
    globalThis.fetch = async (url) => {
        const { pathname } = new URL(url)
        const [status, body] = answers[pathname] ?? assert.fail(`unexpected call to ${pathname}`)
        return Response.json(body, { status })
    }
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const server = createMcpServer({ kind: 'apiKey', apiKey: 'am_test' })
    const client = new Client({ name: 'inbox-hints-test', version: '1.0.0' })
    try {
        await server.connect(serverTransport)
        await client.connect(clientTransport)
        await client.listTools()
        await run((name, args) => client.callTool({ name, arguments: args }))
    } finally {
        globalThis.fetch = realFetch
        await client.close()
        await server.close()
    }
}

test('an account with no inboxes is told to create one, in the text and the structured result', async () => {
    await withApi({ '/v0/inboxes': [200, { count: 0, inboxes: [] }] }, async (call) => {
        const result = await call('list_inboxes', {})
        assert.equal(result.isError, false)
        assert.match(result.structuredContent.hint, /no inboxes yet.*not the user's existing mailbox.*create_inbox/)
        assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent)
        // A later page that happens to be empty says nothing about the account.
        assert.equal((await call('list_inboxes', { pageToken: 'next' })).structuredContent.hint, undefined)
    })
})

test('an account with inboxes gets no hint', async () => {
    const inboxes = [{ inbox_id: 'agent@agentmail.to', email: 'agent@agentmail.to', created_at: '2026-10-27T00:00:00Z', updated_at: '2026-10-27T00:00:00Z' }]
    await withApi({ '/v0/inboxes': [200, { count: 1, inboxes }] }, async (call) => {
        const result = await call('list_inboxes', {})
        assert.equal(result.isError, false, result.content[0].text)
        assert.equal(result.structuredContent.hint, undefined)
    })
})

test('a call with an inbox the account does not have says what an inboxId is', async () => {
    const notFound = [404, { name: 'NotFoundError', message: 'Inbox not found' }]
    const down = [500, { name: 'ServerError', message: 'down' }]
    await withApi({ '/v0/inboxes/person%40gmail.com/messages': notFound, '/v0/inboxes/agent%40agentmail.to/messages': down }, async (call) => {
        const missing = await call('list_messages', { inboxId: 'person@gmail.com' })
        assert.equal(missing.isError, true)
        assert.match(missing.content[0].text, /^Inbox not found.*not the user's own email address.*list_inboxes.*create_inbox/)
        // Any other failure is passed on as it was.
        const other = await call('list_messages', { inboxId: 'agent@agentmail.to' })
        assert.equal(other.isError, true)
        assert.doesNotMatch(other.content[0].text, /inboxId/)
    })
})
