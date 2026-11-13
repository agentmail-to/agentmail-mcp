import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'

// An organization lives in one region and its API keys authenticate only there:
// an am_eu_ key gets 403 on every call to the US host. AGENTMAIL_API_URL is the
// deployment's backend, so an EU key's calls have to go to the EU host instead.
// Two stand-in APIs record which one each call reached.

function standIn(region) {
    const requests = []
    const server = createServer((req, res) => {
        req.resume()
        req.on('end', () => {
            requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization })
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify(req.url.startsWith('/v0/mcp/') ? { events: [] } : { count: 0, inboxes: [], region }))
        })
    })
    return { server, requests }
}

const us = standIn('us')
const eu = standIn('eu')
await new Promise((resolve) => us.server.listen(0, '127.0.0.1', resolve))
await new Promise((resolve) => eu.server.listen(0, '127.0.0.1', resolve))

process.env.AGENTMAIL_MCP_NO_LISTEN = '1'
process.env.AGENTMAIL_API_URL = `http://127.0.0.1:${us.server.address().port}`
process.env.AGENTMAIL_EU_API_URL = `http://127.0.0.1:${eu.server.address().port}/`
const { app, apiEndpointFor } = await import('../packages/server/build/index.js')

const server = app.listen(0)
await new Promise((resolve) => server.once('listening', resolve))
const url = `http://127.0.0.1:${server.address().port}/mcp`

test.after(() => {
    server.close()
    for (const { server: api } of [us, eu]) {
        api.closeAllConnections()
        api.close()
    }
})
test.beforeEach(() => {
    us.requests.length = 0
    eu.requests.length = 0
})

/** The last JSON-RPC message of a response, JSON or SSE. */
async function rpc(apiKey, method, params, headers = {}) {
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-api-key': apiKey, ...headers },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })
    const text = await res.text()
    const data = (res.headers.get('content-type') ?? '').includes('text/event-stream')
        ? text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).at(-1)
        : text
    return JSON.parse(data)
}

test('an am_eu_ key calls the EU API, not the deployment backend', async () => {
    const reply = await rpc('am_eu_test_key', 'tools/call', { name: 'list_inboxes', arguments: {} })
    assert.equal(reply.result?.isError, false, JSON.stringify(reply))
    assert.equal(us.requests.length, 0)
    assert.deepEqual(
        eu.requests.map((r) => [r.method, r.url.split('?')[0], r.authorization]),
        [['GET', '/v0/inboxes', 'Bearer am_eu_test_key']]
    )
})

test('an am_us_ key still calls the deployment backend', async () => {
    const reply = await rpc('am_us_test_key', 'tools/call', { name: 'list_inboxes', arguments: {} })
    assert.equal(reply.result?.isError, false, JSON.stringify(reply))
    assert.equal(eu.requests.length, 0)
    assert.deepEqual(us.requests.map((r) => r.authorization), ['Bearer am_us_test_key'])
})

test('MCP Events with an am_eu_ key are forwarded to the EU API', async () => {
    const reply = await rpc('am_eu_test_key', 'events/list', {
        _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientInfo': { name: 'eu-test', version: '1' },
            'io.modelcontextprotocol/clientCapabilities': {},
        },
    }, { 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'events/list' })
    assert.ok(reply.result, JSON.stringify(reply))
    assert.equal(us.requests.length, 0)
    assert.deepEqual(eu.requests.map((r) => [r.url, r.authorization]), [['/v0/mcp/events', 'Bearer am_eu_test_key']])
})

test('the EU override applies to am_eu_ keys only', () => {
    assert.equal(apiEndpointFor('am_eu_x').http, process.env.AGENTMAIL_EU_API_URL.replace(/\/$/, ''))
    assert.equal(apiEndpointFor('am_us_x').http, process.env.AGENTMAIL_API_URL)
    // Console JWTs (the OAuth path) are not API keys and keep the deployment backend.
    assert.equal(apiEndpointFor('eyJhbGciOiJFUzI1NiJ9.e30.sig').http, process.env.AGENTMAIL_API_URL)
})
