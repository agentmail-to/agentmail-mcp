import assert from 'node:assert/strict'
import test from 'node:test'

process.env.AGENTMAIL_MCP_NO_LISTEN = '1'
const { app } = await import('../packages/server/build/index.js')

async function withServer(t, fn) {
    const server = app.listen(0)
    t.after(() => new Promise((resolve) => server.close(resolve)))
    await new Promise((resolve) => server.once('listening', resolve))
    return fn(server.address().port)
}

const post = (port, body, headers = {}) =>
    fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            ...headers,
        },
        body: JSON.stringify(body),
    })

test('ping is answered from the fast path with a plain JSON-RPC response', async (t) => {
    await withServer(t, async (port) => {
        const res = await post(port, { jsonrpc: '2.0', id: 42, method: 'ping' })
        assert.equal(res.status, 200)
        // Plain JSON, not SSE: the fast path never builds the transport. Both
        // are legal for Streamable HTTP clients, which must accept either.
        assert.match(res.headers.get('content-type') ?? '', /application\/json/)
        assert.deepEqual(await res.json(), { jsonrpc: '2.0', id: 42, result: {} })

        const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json()
        assert.ok(health.requests.pings_fast_path >= 1, 'counter tracks fast-pathed pings')
    })
})

test('ping echoes string ids exactly', async (t) => {
    await withServer(t, async (port) => {
        const res = await post(port, { jsonrpc: '2.0', id: 'req-abc', method: 'ping' })
        assert.deepEqual(await res.json(), { jsonrpc: '2.0', id: 'req-abc', result: {} })
    })
})

test('ping needs no credentials — a probe must not cost an auth round-trip', async (t) => {
    await withServer(t, async (port) => {
        // No x-api-key, no Authorization. Skipping auth is the point of the
        // fast path (verification is most of the per-ping cost) and the
        // response is a constant, so nothing leaks.
        const res = await post(port, { jsonrpc: '2.0', id: 1, method: 'ping' })
        assert.equal(res.status, 200)
    })
})

test('a ping-shaped notification (no id) falls through to the SDK', async (t) => {
    await withServer(t, async (port) => {
        // Without an id this is a notification; the transport acknowledges
        // notifications with 202 and no body. The fast path must not swallow it.
        const res = await post(port, { jsonrpc: '2.0', method: 'ping' })
        assert.equal(res.status, 202)
    })
})

test('non-ping requests still take the full path', async (t) => {
    await withServer(t, async (port) => {
        const res = await post(
            port,
            {
                jsonrpc: '2.0',
                id: 1,
                method: 'initialize',
                params: {
                    protocolVersion: '2025-06-18',
                    capabilities: {},
                    clientInfo: { name: 'test', version: '1' },
                },
            },
            { 'x-api-key': 'am_dummy' }
        )
        assert.equal(res.status, 200)
        // The full path answers via the SDK transport (SSE), proving initialize
        // did not get intercepted by the ping shortcut.
        assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/)
    })
})
