import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'

process.env.AGENTMAIL_MCP_NO_LISTEN = '1'
// Both are read once at module load, so they have to be set before the import.
// A cap of 2 is enough to exercise admit/shed/release without needing timing.
process.env.AGENTMAIL_MAX_IN_FLIGHT = '2'
// Floored at 1000 ms by the implementation, so this is the fastest a timeout
// test can run.
process.env.AGENTMAIL_REQUEST_TIMEOUT_MS = '1000'
process.env.AGENTMAIL_MAX_EVENT_LOOP_LAG_MS = '300'
// The budget is floored at one max-size request (10 MiB) so a lone large send
// is never shed by configuration; set it to exactly that floor so two 6 MB
// declarations exceed it while the in-flight count (cap 2) does not.
process.env.AGENTMAIL_MAX_IN_FLIGHT_BYTES = String(10 * 1024 * 1024)
const { app, admissionControl, requestTimeout } = await import('../packages/server/build/index.js')

/** Minimal stand-in for an Express response: records what the middleware did. */
function mockRes() {
    const res = new EventEmitter()
    res.locals = {}
    res.statusCode = undefined
    res.headers = {}
    res.body = undefined
    res.headersSent = false
    res.status = (code) => {
        res.statusCode = code
        return res
    }
    res.set = (key, value) => {
        res.headers[typeof key === 'object' ? Object.keys(key)[0] : key] =
            typeof key === 'object' ? Object.values(key)[0] : value
        return res
    }
    res.json = (payload) => {
        res.body = payload
        res.headersSent = true
        return res
    }
    return res
}

function admit(headers = {}) {
    const res = mockRes()
    let passed = false
    admissionControl({ headers }, res, () => {
        passed = true
    })
    return { res, passed }
}

test('admission control admits up to the cap and sheds the excess instantly', () => {
    const first = admit()
    const second = admit()
    assert.equal(first.passed, true)
    assert.equal(second.passed, true)

    // Third request is over the cap. It must be rejected without reaching the
    // next handler at all: the whole point is that a shed request costs no
    // per-request graph and no Clerk verification.
    const third = admit()
    assert.equal(third.passed, false)
    assert.equal(third.res.statusCode, 503)

    // Retry-After is what converts a shed into client backoff. Without it a
    // client is free to retry immediately, which is the loop we are breaking.
    assert.ok(Number(third.res.headers['Retry-After']) >= 1)
    assert.equal(third.res.body.jsonrpc, '2.0')
    assert.equal(third.res.body.error.code, -32000)
    assert.match(third.res.body.error.message, /overloaded/i)

    first.res.emit('close')
    second.res.emit('close')
})

test('a finished request returns its slot', () => {
    const first = admit()
    const second = admit()
    assert.equal(admit().passed, false, 'cap reached')

    first.res.emit('close')

    const afterRelease = admit()
    assert.equal(afterRelease.passed, true, 'freed slot is reusable')

    second.res.emit('close')
    afterRelease.res.emit('close')
})

test('a double close does not release the same slot twice', () => {
    const first = admit()
    const second = admit()

    // Express can emit 'close' after 'finish'. If that double-counted, in-flight
    // would drift below zero and the effective cap would grow without bound —
    // silently disabling admission control exactly when it is needed.
    first.res.emit('close')
    first.res.emit('close')

    const third = admit()
    assert.equal(third.passed, true, 'one slot was freed')
    const fourth = admit()
    assert.equal(fourth.passed, false, 'cap still 2, not 3')

    second.res.emit('close')
    third.res.emit('close')
})

test('declared request bodies are budgeted, not just counted', () => {
    // Two requests are under the in-flight cap of 2, but their declared bodies
    // (6 MB + 6 MB) exceed the 10 MiB budget. The budget is what stops a burst
    // of near-10 MB attachment sends from being parsed into the heap at once —
    // the per-request limit alone caps each body, not their sum.
    const first = admit({ 'content-length': '6000000' })
    assert.equal(first.passed, true)

    const second = admit({ 'content-length': '6000000' })
    assert.equal(second.passed, false, 'over budget is shed even though the count cap has room')
    assert.equal(second.res.statusCode, 503)
    assert.ok(Number(second.res.headers['Retry-After']) >= 1)
    assert.match(second.res.body.error.message, /overloaded/i)

    // A request that declares no length costs nothing against the budget: the
    // per-request parser limit still bounds it, and most clients do send one.
    const undeclared = admit({})
    assert.equal(undeclared.passed, true)

    first.res.emit('close')
    const afterRelease = admit({ 'content-length': '6000000' })
    assert.equal(afterRelease.passed, true, 'bytes are returned with the slot')

    undeclared.res.emit('close')
    afterRelease.res.emit('close')
})

test('a request that never responds is timed out so its slot comes back', async () => {
    const res = mockRes()
    // next() is intentionally a no-op: this models the contained-unhandled-
    // rejection path, where the request deliberately gets no response and would
    // otherwise pin its slot until the client gave up.
    requestTimeout({}, res, () => {})

    await new Promise((resolve) => setTimeout(resolve, 1300))

    assert.equal(res.statusCode, 504)
    assert.equal(res.body.error.code, -32000)
    assert.match(res.body.error.message, /timed out/i)
})

test('a saturated event loop sheds even while in-flight is zero', async (t) => {
    const server = app.listen(0)
    t.after(() => server.close())
    await new Promise((resolve) => server.once('listening', resolve))
    const { port } = server.address()

    // Not a ping: pings are answered before admission control precisely so
    // that shedding never applies to them. tools/list goes through the full
    // admission path and needs no upstream call.
    const probe = () =>
        fetch(`http://127.0.0.1:${port}/mcp`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                accept: 'application/json, text/event-stream',
                'x-api-key': 'am_dummy',
            },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
        }).then(async (res) => {
            // Drain so the connection and its admission slot are released.
            const body = await res.text()
            return { status: res.status, retryAfter: res.headers.get('retry-after'), body }
        })

    assert.equal((await probe()).status, 200, 'healthy server admits')

    // Reproduce sustained saturation, which is what the outage actually was:
    // back-to-back CPU chunks with only a bare yield between them, so the loop is
    // never idle and every delay sample lands late. One long block would not do
    // it — the window would still be mostly idle samples and the mean, which is
    // deliberately the statistic here, would average them away.
    //
    // Crucially nothing is in flight while this runs, so an in-flight counter
    // would read zero and admit everything. The loop-lag trigger is what sees it.
    const saturateUntil = Date.now() + 3000
    while (Date.now() < saturateUntil) {
        const chunkUntil = Date.now() + 600
        while (Date.now() < chunkUntil) {
            /* burn a chunk the loop cannot interrupt */
        }
        await new Promise((resolve) => setImmediate(resolve))
    }

    const shedRes = await probe()
    assert.equal(shedRes.status, 503)
    assert.ok(Number(shedRes.retryAfter) >= 1)
    assert.equal(JSON.parse(shedRes.body).error.code, -32000)

    const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json()
    assert.ok(health.requests.event_loop_lag_ms > health.requests.max_event_loop_lag_ms)
    assert.equal(health.requests.in_flight, 0, 'shed happened with nothing in flight')

    // Once the loop is idle again the next sample clears and traffic is admitted
    // without any intervention — shedding has to be self-healing, or it would
    // turn a transient spike into a permanent outage.
    await new Promise((resolve) => setTimeout(resolve, 2400))
    assert.equal((await probe()).status, 200, 'recovers on its own')
})

test('the timeout does not fire once the response is already sent', async () => {
    const res = mockRes()
    requestTimeout({}, res, () => {})

    res.status(200).json({ ok: true })
    res.emit('close')

    await new Promise((resolve) => setTimeout(resolve, 1300))

    // Still the handler's own response — the timer must neither overwrite it
    // nor attempt a second write.
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.body, { ok: true })
})
