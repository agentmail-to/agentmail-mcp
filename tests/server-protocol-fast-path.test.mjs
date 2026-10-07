import assert from 'node:assert/strict'
import test from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

process.env.AGENTMAIL_MCP_NO_LISTEN = '1'

const { app, createMcpServer } = await import('../packages/server/build/index.js')

const server = app.listen(0)
await new Promise((resolve) => server.once('listening', resolve))
const { port } = server.address()
test.after(() => server.close())

const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'x-api-key': 'am_dummy',
}
const post = (body, extraHeaders = {}) =>
    fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: { ...headers, ...extraHeaders }, body: JSON.stringify(body) })

/** What the SDK itself answers for this server, over an in-memory transport. */
async function reference(t) {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const mcp = createMcpServer({ kind: 'apiKey', apiKey: 'am_dummy' })
    const client = new Client({ name: 'reference', version: '1.0.0' })
    t.after(async () => {
        await client.close().catch(() => {})
        await mcp.close().catch(() => {})
    })
    await mcp.connect(serverTransport)
    await client.connect(clientTransport)
    return client
}

const initialize = (protocolVersion, id = 7) => ({
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: { protocolVersion, capabilities: {}, clientInfo: { name: 'cursor', version: '1.0' } },
})

test('initialize is answered from the cache with the same capabilities, serverInfo, and instructions as the SDK', async (t) => {
    const client = await reference(t)
    const res = await post(initialize('2025-06-18', 'abc'))
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type'), /application\/json/)
    const body = await res.json()
    assert.equal(body.jsonrpc, '2.0')
    assert.equal(body.id, 'abc')
    assert.equal(body.result.protocolVersion, '2025-06-18', 'a supported version is echoed')
    assert.deepEqual(body.result.capabilities, client.getServerCapabilities())
    assert.deepEqual(body.result.serverInfo, client.getServerVersion())
    assert.equal(body.result.instructions, client.getInstructions())
})

test('an unsupported protocol version negotiates down to the latest, as the SDK does', async () => {
    const body = await (await post(initialize('2031-01-01'))).json()
    assert.equal(body.result.protocolVersion, '2025-11-25')
})

test('tools/list is answered from the cache with exactly the SDK catalog', async (t) => {
    const client = await reference(t)
    const { tools } = await client.listTools()
    const res = await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type'), /application\/json/)
    const body = await res.json()
    // The SDK client's zod parse leaves explicit `undefined` keys that JSON
    // drops either way; compare what goes on the wire.
    assert.deepEqual(body.result, JSON.parse(JSON.stringify({ tools })))
    assert.ok(tools.length > 30)
})

test('notifications/initialized is acknowledged with an empty 202', async () => {
    const res = await post({ jsonrpc: '2.0', method: 'notifications/initialized' })
    assert.equal(res.status, 202)
    assert.equal(await res.text(), '')
})

test('bodies the SDK would reject fall through to the SDK and get its error, not a cached success', async () => {
    // Extra key on a notification: the SDK's JSON-RPC schemas are strict.
    const extra = await post({ jsonrpc: '2.0', method: 'notifications/initialized', extra: 1 })
    assert.equal(extra.status, 400)

    // Missing clientInfo.version: valid JSON-RPC, invalid initialize params.
    // The SDK answers over SSE with a JSON-RPC error.
    const bad = initialize('2025-11-25')
    delete bad.params.clientInfo.version
    const res = await post(bad)
    assert.match(res.headers.get('content-type'), /text\/event-stream/)
    const text = await res.text()
    assert.match(text, /"error"/)

    // Unsupported mcp-protocol-version header: the SDK returns 400.
    const header = await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { 'mcp-protocol-version': '1999-01-01' })
    assert.equal(header.status, 400)
})

test('the fast path counts what it answered', async () => {
    const h = await (await fetch(`http://127.0.0.1:${port}/health`)).json()
    assert.ok(h.requests.protocol_fast_path.initialize >= 2)
    assert.ok(h.requests.protocol_fast_path.tools_list >= 1)
    assert.ok(h.requests.protocol_fast_path.initialized >= 1)
})
