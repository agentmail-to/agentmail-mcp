import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'

process.env.AGENTMAIL_MCP_NO_LISTEN = '1'
process.env.AGENTMAIL_REQUEST_TIMEOUT_MS = '1000'

const { app, admissionControl, requestTimeout, mcpHandler, rejectBatch, startListening, beginDrain } =
    await import('../packages/server/build/index.js')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function mockRes() {
    const res = new EventEmitter()
    res.locals = {}
    res.headers = {}
    res.headersSent = false
    res.writableEnded = false
    res.destroyed = false
    res.status = (code) => {
        res.statusCode = code
        return res
    }
    res.set = (key, value) => {
        res.headers[key] = value
        return res
    }
    res.json = (payload) => {
        res.body = payload
        res.headersSent = true
        res.writableEnded = true
        return res
    }
    return res
}

async function health(port) {
    const r = await fetch(`http://127.0.0.1:${port}/health`)
    return { status: r.status, body: await r.json() }
}

test('a JSON-RPC batch is rejected before it reaches the MCP server', async (t) => {
    const server = app.listen(0)
    t.after(() => server.close())
    await new Promise((resolve) => server.once('listening', resolve))
    const { port } = server.address()

    // 100 tool calls in one array would be dispatched by the SDK transport
    // through a single admission slot and a single Clerk verification.
    const batch = Array.from({ length: 100 }, (_, i) => ({
        jsonrpc: '2.0',
        id: i,
        method: 'tools/call',
        params: { name: 'list_inboxes', arguments: {} },
    }))
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            'x-api-key': 'am_dummy',
        },
        body: JSON.stringify(batch),
    })
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.equal(body.error.code, -32600)
    assert.match(body.error.message, /batch/i)

    const h = await health(port)
    assert.equal(h.body.requests.batches_rejected, 1)
    assert.equal(h.body.requests.in_flight, 0, 'the slot came back')
})

test('rejectBatch lets single messages through untouched', () => {
    let passed = false
    rejectBatch({ body: { jsonrpc: '2.0', id: 1, method: 'ping' } }, mockRes(), () => {
        passed = true
    })
    assert.equal(passed, true)
})

test('after a 504 the handler does not build a server or run the tool', async () => {
    // Model the slow path: requestTimeout fires while the chain is still
    // suspended upstream (body parse of a slow upload, a Clerk round trip),
    // then the chain resumes and reaches mcpHandler.
    const res = mockRes()
    let admitted = false
    admissionControl({}, res, () => {
        admitted = true
    })
    assert.equal(admitted, true)
    requestTimeout({}, res, () => {})
    await sleep(1300)
    assert.equal(res.statusCode, 504)
    assert.equal(res.locals.timedOut, true)
    res.emit('close')

    // The 504 was written and the connection closed; mcpHandler must return
    // without touching the response. A createMcpServer call here would need
    // an auth source and would try to write SSE headers onto a finished
    // response, so "no throw, no writes" is the observable contract.
    const before = { ...res }
    await mcpHandler({ authSource: { kind: 'none' }, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } }, res)
    assert.equal(res.statusCode, before.statusCode)
    assert.deepEqual(res.body, before.body)
})

test('the skipped-after-timeout counter is reported', async (t) => {
    const server = app.listen(0)
    t.after(() => server.close())
    await new Promise((resolve) => server.once('listening', resolve))
    const { port } = server.address()
    const h = await health(port)
    assert.ok(h.body.requests.skipped_after_timeout >= 1, 'the previous test skipped one')
})

test('beginDrain stops accepting, sheds new requests, waits for in-flight work, then exits', async () => {
    const server = startListening(0)
    await new Promise((resolve) => server.once('listening', resolve))
    const { port } = server.address()
    assert.equal((await health(port)).status, 200)

    // Hold one slot the way an in-flight tool call would.
    const held = mockRes()
    admissionControl({}, held, () => {})

    let exitCode
    const drained = beginDrain(server, {
        reason: 'test',
        timeoutMs: 5000,
        exit: (code) => {
            exitCode = code
        },
    })
    assert.equal(beginDrain(server), drained, 'a second signal reuses the first drain')
    await sleep(100)
    assert.equal(exitCode, undefined, 'still waiting on the in-flight request')

    // Listener is closed: a new connection is refused.
    await assert.rejects(fetch(`http://127.0.0.1:${port}/health`))

    // A request that arrives on an already-open keep-alive connection is shed
    // with Retry-After and Connection: close, so the client moves on instead
    // of waiting for a process that is about to exit.
    const late = mockRes()
    let admitted = false
    admissionControl({}, late, () => {
        admitted = true
    })
    assert.equal(admitted, false)
    assert.equal(late.statusCode, 503)
    assert.equal(late.headers.Connection, 'close')
    assert.ok(Number(late.headers['Retry-After']) >= 1)

    held.emit('close')
    await drained
    assert.equal(exitCode, 0)
})
