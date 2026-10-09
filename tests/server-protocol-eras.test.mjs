import assert from 'node:assert/strict'
import test from 'node:test'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'

process.env.AGENTMAIL_MCP_NO_LISTEN = '1'
// Fake but well-formed Clerk keys, so the OAuth challenge path is mounted.
process.env.CLERK_PUBLISHABLE_KEY = `pk_test_${Buffer.from('example.clerk.accounts.dev$').toString('base64')}`
process.env.CLERK_SECRET_KEY = 'sk_test_protocol_eras'

const { app } = await import('../packages/server/build/index.js')

const server = app.listen(0)
await new Promise((resolve) => server.once('listening', resolve))
const { port } = server.address()
const url = new URL(`http://127.0.0.1:${port}/mcp`)
test.after(() => server.close())

async function connect(t, mode) {
    const client = new Client({ name: 'eras-test', version: '1.0.0' }, { versionNegotiation: { mode } })
    t.after(() => client.close().catch(() => {}))
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { 'x-api-key': 'am_dummy' } } }))
    return client
}

const counters = async () => (await (await fetch(`http://127.0.0.1:${port}/health`)).json()).requests.protocol_fast_path

const MODERN_META = {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientInfo': { name: 'eras-test', version: '1' },
    'io.modelcontextprotocol/clientCapabilities': {},
}

/** A raw 2026-07-28 request, so assertions see the wire and not a client's parsed view. */
const modern = (method, extraHeaders = { 'x-api-key': 'am_dummy' }) =>
    fetch(url, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            'mcp-protocol-version': '2026-07-28',
            'mcp-method': method,
            ...extraHeaders,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'eras', method, params: { _meta: MODERN_META } }),
    })

test('a 2026-07-28 client negotiates the modern era over server/discover', async (t) => {
    const client = await connect(t, { pin: '2026-07-28' })
    assert.equal(client.getProtocolEra(), 'modern')
    assert.equal(client.getNegotiatedProtocolVersion(), '2026-07-28')
    assert.match(client.getInstructions() ?? '', /AgentID/, 'instructions delivered on the modern path')
})

test('server/discover on the wire offers 2026-07-28 with the tools capability', async () => {
    const res = await modern('server/discover')
    assert.equal(res.status, 200)
    const { result } = await res.json()
    assert.deepEqual(result.supportedVersions, ['2026-07-28'])
    assert.ok(result.capabilities.tools)
    assert.match(result.instructions, /AgentID/)
})

test('modern tools/list and tools/call go to the SDK, not the 2025-era fast path', async (t) => {
    const before = await counters()
    const client = await connect(t, { pin: '2026-07-28' })
    const { tools } = await client.listTools()
    assert.ok(tools.length > 30)
    assert.equal((await counters()).tools_list, before.tools_list)
    // No real API behind it: the call must still come back as a tool result, not a protocol error.
    const result = await client.callTool({ name: 'list_inboxes', arguments: { limit: 1 } })
    assert.equal(typeof result.isError, 'boolean')
})

test('a 2025-era client still negotiates the legacy era and works', async (t) => {
    const client = await connect(t, 'legacy')
    assert.equal(client.getProtocolEra(), 'legacy')
    assert.equal(client.getNegotiatedProtocolVersion(), '2025-11-25')
    const { tools } = await client.listTools()
    assert.ok(tools.length > 30)
})

test('an unauthenticated server/discover gets the OAuth challenge, as initialize does', async () => {
    const res = await modern('server/discover', {})
    assert.equal(res.status, 401)
    assert.match(res.headers.get('www-authenticate') ?? '', /resource_metadata=/)
})
