import assert from 'node:assert/strict'
import test from 'node:test'

process.env.AGENTMAIL_MCP_NO_LISTEN = '1'

const { app } = await import('../packages/server/build/index.js')

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

/** The JSON-RPC message in a response, whether sent as JSON or as a one-event SSE stream. */
async function messageOf(res) {
    const text = await res.text()
    if (!(res.headers.get('content-type') ?? '').includes('text/event-stream')) return JSON.parse(text)
    const data = text
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice('data:'.length).trim())
    return JSON.parse(data.at(-1))
}

/** The same request answered by the full SDK path: the fast path switched off for this one call. */
async function fullPath(body) {
    process.env.AGENTMAIL_PROTOCOL_FAST_PATH = '0'
    try {
        const res = await post(body)
        return { res, message: await messageOf(res) }
    } finally {
        delete process.env.AGENTMAIL_PROTOCOL_FAST_PATH
    }
}

const initialize = (protocolVersion, id = 7) => ({
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: { protocolVersion, capabilities: {}, clientInfo: { name: 'cursor', version: '1.0' } },
})

const counters = async () => (await (await fetch(`http://127.0.0.1:${port}/health`)).json()).requests.protocol_fast_path

test('initialize from the fast path is exactly what the full SDK path answers, for every 2025-era version', async () => {
    for (const version of ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']) {
        const before = await counters()
        const res = await post(initialize(version, `id-${version}`))
        assert.equal(res.status, 200)
        assert.match(res.headers.get('content-type'), /application\/json/, 'served by the fast path')
        const fast = await res.json()
        assert.equal((await counters()).initialize, before.initialize + 1)

        const { message: full } = await fullPath(initialize(version, `id-${version}`))
        assert.deepEqual(fast, full, `initialize ${version}`)
        assert.equal(fast.result.protocolVersion, version)
    }
})

test('an unsupported protocol version negotiates down exactly as the SDK does', async () => {
    const fast = await (await post(initialize('2031-01-01'))).json()
    const { message: full } = await fullPath(initialize('2031-01-01'))
    assert.deepEqual(fast, full)
    assert.equal(fast.result.protocolVersion, '2025-11-25')
})

test('tools/list from the fast path is exactly the full SDK path catalog', async () => {
    const res = await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type'), /application\/json/)
    const fast = await res.json()
    const { message: full } = await fullPath({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    assert.deepEqual(fast, full)
    assert.ok(fast.result.tools.length > 30)
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
    const bad = initialize('2025-11-25')
    delete bad.params.clientInfo.version
    const res = await post(bad)
    assert.match(res.headers.get('content-type'), /text\/event-stream/, 'answered by the SDK, not the fast path')
    assert.ok((await messageOf(res)).error)

    // Unsupported mcp-protocol-version header: the SDK returns 400.
    const header = await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { 'mcp-protocol-version': '1999-01-01' })
    assert.equal(header.status, 400)
})

test('a 2026-07-28 request is never answered from the 2025-era snapshot', async () => {
    const before = await counters()
    // An envelope claim in params._meta marks the modern era. Whatever else is
    // wrong with this request (no MCP-Protocol-Version header, incomplete
    // envelope), the SDK owns the answer: a cached 2025-era success here would
    // hide the error a 2026 client needs to see.
    const res = await post({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } },
    })
    assert.equal(res.status, 400)
    assert.ok((await res.json()).error, 'answered with the SDK error')
    assert.equal((await counters()).tools_list, before.tools_list, 'not served from the snapshot')
})

test('the fast path counts what it answered', async () => {
    const h = await counters()
    assert.ok(h.initialize >= 5)
    assert.ok(h.tools_list >= 1)
    assert.ok(h.initialized >= 1)
})
