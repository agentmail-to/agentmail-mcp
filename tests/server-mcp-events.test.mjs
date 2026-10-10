import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'

// MCP Events on the hosted server: 2026-07-28 only, and pure forwarding to the AgentMail API's
// /v0/mcp routes, which own the catalog, validation and delivery. The API here is a stand-in that
// records exactly what the MCP server sent and answers what each test chooses.

const CATALOG = {
    events: [
        {
            name: 'message.received',
            description: 'An email arrived.',
            delivery: ['webhook'],
            inputSchema: { type: 'object', properties: { inboxId: { type: 'string' } }, required: ['inboxId'] },
            payloadSchema: { type: 'object', properties: { messageId: { type: 'string' } } },
        },
    ],
}

let apiRequests = []
let apiReply = () => ({ status: 200, body: CATALOG })
const api = createServer((req, res) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
        apiRequests.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body: body ? JSON.parse(body) : undefined })
        const reply = apiReply(req)
        res.writeHead(reply.status, { 'content-type': 'application/json' })
        res.end(reply.body === undefined ? '' : JSON.stringify(reply.body))
    })
})
await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve))

process.env.AGENTMAIL_MCP_NO_LISTEN = '1'
process.env.AGENTMAIL_API_URL = `http://127.0.0.1:${api.address().port}`
const { app } = await import('../packages/server/build/index.js')

const server = app.listen(0)
await new Promise((resolve) => server.once('listening', resolve))
const url = `http://127.0.0.1:${server.address().port}/mcp`
test.after(() => {
    server.close()
    api.closeAllConnections()
    api.close()
})
test.beforeEach(() => {
    apiRequests = []
    apiReply = () => ({ status: 200, body: CATALOG })
})

const META = {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientInfo': { name: 'chatgpt-test', version: '1' },
    'io.modelcontextprotocol/clientCapabilities': {},
}

/** One 2026-07-28 request on the wire; returns the JSON-RPC message (JSON or one-event SSE). */
async function modern(method, params = {}) {
    const res = await fetch(url, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            'x-api-key': 'am_test_key',
            'mcp-protocol-version': '2026-07-28',
            'mcp-method': method,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: META } }),
    })
    const text = await res.text()
    const data = (res.headers.get('content-type') ?? '').includes('text/event-stream')
        ? text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).at(-1)
        : text
    return JSON.parse(data)
}

async function legacy(method, params = {}) {
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-api-key': 'am_test_key' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })
    const text = await res.text()
    const data = (res.headers.get('content-type') ?? '').includes('text/event-stream')
        ? text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).at(-1)
        : text
    return JSON.parse(data)
}

/** A 2026-07-28 result minus the fields the protocol adds to every result (resultType, _meta.serverInfo). */
function payloadOf(result) {
    assert.equal(result.resultType, 'complete')
    assert.ok(result._meta?.['io.modelcontextprotocol/serverInfo'])
    const { resultType: _r, _meta: _m, ...rest } = result
    return rest
}

const subscribeParams = {
    name: 'message.received',
    arguments: { inboxId: 'agent@example.com' },
    delivery: { mode: 'webhook', url: 'https://chatgpt.example.com/cb', secret: `whsec_${Buffer.alloc(32, 7).toString('base64')}` },
    cursor: null,
    ttlMs: 3_600_000,
}

test('server/discover advertises events to 2026-07-28 clients; 2025-era initialize does not', async () => {
    const discover = await modern('server/discover')
    assert.deepEqual(discover.result.capabilities.events, {})

    const initialize = await legacy('initialize', {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'cursor', version: '1' },
    })
    assert.equal(initialize.result.capabilities.events, undefined)
    assert.ok(initialize.result.capabilities.tools)
})

test('events/list returns the API catalog, fetched with the caller’s own credential', async () => {
    const reply = await modern('events/list')
    assert.deepEqual(payloadOf(reply.result), CATALOG)
    assert.deepEqual(
        apiRequests.map(({ method, url: path, authorization }) => ({ method, path, authorization })),
        [{ method: 'GET', path: '/v0/mcp/events', authorization: 'Bearer am_test_key' }]
    )
})

test('events/subscribe forwards the MCP params unchanged and returns the API result', async () => {
    const result = { id: 'sub_abc', refreshBefore: '2026-10-12T00:00:00.000Z', cursor: null, truncated: false }
    apiReply = () => ({ status: 200, body: result })
    const reply = await modern('events/subscribe', subscribeParams)
    assert.deepEqual(payloadOf(reply.result), result)
    const [request] = apiRequests
    assert.equal(request.method, 'POST')
    assert.equal(request.url, '/v0/mcp/events/subscribe')
    assert.equal(request.authorization, 'Bearer am_test_key')
    // API-key callers are their own principal: none is added, and _meta never reaches the API.
    assert.deepEqual(request.body, subscribeParams)
})

test('a failed callback verification surfaces as CallbackEndpointError -32015 with the API reason', async () => {
    apiReply = () => ({
        status: 422,
        body: { name: 'CallbackEndpointError', code: 'unprocessable', message: 'The callback endpoint failed verification: timeout', reason: 'timeout' },
    })
    const reply = await modern('events/subscribe', subscribeParams)
    assert.equal(reply.error.code, -32015)
    assert.deepEqual(reply.error.data, { reason: 'timeout' })
})

test('API refusals map to JSON-RPC errors carrying the API message', async () => {
    apiReply = () => ({ status: 400, body: { message: 'Request validation failed', errors: [{ path: ['delivery', 'url'] }] } })
    assert.equal((await modern('events/subscribe', subscribeParams)).error.code, -32602)

    apiReply = () => ({ status: 403, body: { message: 'Missing permission: webhook_create' } })
    const forbidden = await modern('events/subscribe', subscribeParams)
    assert.equal(forbidden.error.code, -32600)
    assert.match(forbidden.error.message, /webhook_create/)

    apiReply = () => ({ status: 503, body: { message: 'internal detail' } })
    const unavailable = await modern('events/subscribe', subscribeParams)
    assert.equal(unavailable.error.code, -32603)
    assert.doesNotMatch(unavailable.error.message, /internal detail/)
})

test('events/unsubscribe forwards name, arguments and delivery target, and returns {}', async () => {
    apiReply = () => ({ status: 204 })
    const reply = await modern('events/unsubscribe', {
        name: 'message.received',
        arguments: { inboxId: 'agent@example.com' },
        delivery: { mode: 'webhook', url: 'https://chatgpt.example.com/cb' },
    })
    assert.deepEqual(payloadOf(reply.result), {})
    assert.deepEqual(apiRequests[0].body, {
        name: 'message.received',
        arguments: { inboxId: 'agent@example.com' },
        delivery: { mode: 'webhook', url: 'https://chatgpt.example.com/cb' },
    })
})

test('2025-era clients cannot call events/* at all', async () => {
    const reply = await legacy('events/list')
    assert.equal(reply.error.code, -32601)
    assert.equal(apiRequests.length, 0)
})
