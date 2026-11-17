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

async function connect(t, mode, options = {}) {
    const client = new Client({ name: 'eras-test', version: '1.0.0' }, { versionNegotiation: { mode }, ...options })
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
const modern = (method, extraHeaders = { 'x-api-key': 'am_dummy' }, params = {}, init = {}) =>
    fetch(url, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            'mcp-protocol-version': '2026-07-28',
            'mcp-method': method,
            ...extraHeaders,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'eras', method, params: { ...params, _meta: MODERN_META } }),
        ...init,
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

/** The JSON-RPC message in a response, whether sent as JSON or as a one-event SSE stream. */
async function messageOf(res) {
    const text = await res.text()
    if (!(res.headers.get('content-type') ?? '').includes('text/event-stream')) return JSON.parse(text)
    return JSON.parse(
        text
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .at(-1)
            .slice('data:'.length)
    )
}

test('2026-07-28 tools/list may be cached per caller for five minutes; nothing else changes', async () => {
    const { result: list } = await messageOf(await modern('tools/list'))
    assert.equal(list.ttlMs, 5 * 60 * 1000)
    // Private: users in the get_started test get a different list.
    assert.equal(list.cacheScope, 'private')

    // server/discover keeps the SDK's conservative defaults.
    const { result: discover } = await messageOf(await modern('server/discover'))
    assert.equal(discover.ttlMs, 0)
    assert.equal(discover.cacheScope, 'private')

    // 2025-era responses never carry cache fields.
    const legacy = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-api-key': 'am_dummy' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    const { result: legacyList } = await messageOf(legacy)
    assert.ok(legacyList.tools.length > 30)
    assert.equal('ttlMs' in legacyList, false)
    assert.equal('cacheScope' in legacyList, false)
})

test('an unauthenticated server/discover gets the OAuth challenge, as initialize does', async () => {
    const res = await modern('server/discover', {})
    assert.equal(res.status, 401)
    assert.match(res.headers.get('www-authenticate') ?? '', /resource_metadata=/)
})

// This stateless server never sends tools/list_changed: the tool list changes only with a
// deploy, and clients see it on their next tools/list. Advertising listChanged made Claude Code
// open subscriptions/listen streams that sat idle in an admission slot until requestTimeout cut
// them at 30 s, about 550k a day (Manufact, 2026-10-13..19).
test('a 2026-07-28 client that watches the tool list opens no listen stream', async (t) => {
    const client = await connect(t, { pin: '2026-07-28' }, { listChanged: { tools: { onChanged: () => {} } } })
    assert.equal(client.getProtocolEra(), 'modern')
    assert.equal(client.autoOpenedSubscription, undefined)
})

test('neither era advertises tools.listChanged', async () => {
    const { result: discover } = await messageOf(await modern('server/discover'))
    assert.equal(discover.capabilities.tools.listChanged, false)

    const legacy = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-api-key': 'am_dummy' },
        body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'eras-test', version: '1' } },
        }),
    })
    const { result: initialize } = await messageOf(legacy)
    assert.equal(initialize.capabilities.tools.listChanged, false)
})

// For a client that listens anyway: nothing it asks for can be honored, so the stream is
// acknowledged and ended at once rather than left holding a slot until requestTimeout.
test('a listen request for tool changes is acknowledged and ended at once', async () => {
    const started = Date.now()
    const res = await modern(
        'subscriptions/listen',
        undefined,
        { notifications: { toolsListChanged: true } },
        { signal: AbortSignal.timeout(10_000) }
    )
    const text = await res.text()
    assert.ok(Date.now() - started < 5_000, `listen stayed open ${Date.now() - started} ms`)
    assert.match(text, /notifications\/subscriptions\/acknowledged/)
    assert.match(text, /"resultType":"complete"/)
})
