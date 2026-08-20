import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'

// A stand-in AgentMail API that accepts the connection and then never answers.
// This is the shape that matters: StreamableHTTPServerTransport has already
// written SSE headers by the time a tools/call handler blocks on it, so these
// requests exercise the headers-already-sent path that a plain `if
// (res.headersSent) return` timeout silently skips.
let upstreamLive = 0
const hangingUpstream = createServer((req) => {
    // Hold the request open forever, but track whether it is still open so the
    // tests can assert on real upstream work rather than just our own counter.
    upstreamLive++
    req.on('close', () => {
        upstreamLive--
    })
})
await new Promise((resolve) => hangingUpstream.listen(0, '127.0.0.1', resolve))
const upstreamPort = hangingUpstream.address().port

process.env.AGENTMAIL_MCP_NO_LISTEN = '1'
process.env.AGENTMAIL_API_URL = `http://127.0.0.1:${upstreamPort}`
// Floored at 1000 ms by the implementation.
process.env.AGENTMAIL_REQUEST_TIMEOUT_MS = '1000'
// Small enough that two stuck calls fill it, which is the "shedding forever"
// case being guarded against.
process.env.AGENTMAIL_MAX_IN_FLIGHT = '2'
const { app } = await import('../packages/server/build/index.js')

async function withServer(t, fn) {
    const server = app.listen(0)
    t.after(() => {
        server.close()
    })
    await new Promise((resolve) => server.once('listening', resolve))
    return fn(server.address().port)
}

const health = async (port) => (await fetch(`http://127.0.0.1:${port}/health`)).json()

function callHangingTool(port, signal) {
    return fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        signal,
        headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            'x-api-key': 'am_dummy',
        },
        body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'list_inboxes', arguments: {} },
        }),
    })
}

/** Drive the call to completion however it ends: reset, error body, or reply. */
async function settle(promise) {
    try {
        const res = await promise
        await res.text()
    } catch {
        /* a destroyed connection surfaces as a fetch/body error, which is the point */
    }
}

test('a tool call stuck on a hung upstream still gives its slot back', async (t) => {
    await withServer(t, async (port) => {
        const inFlightBefore = (await health(port)).requests.in_flight
        assert.equal(inFlightBefore, 0)

        const call = settle(callHangingTool(port))

        // The upstream never answers, so this only returns because the timeout
        // tore the connection down.
        await call

        // Give the release a tick to land.
        await new Promise((resolve) => setTimeout(resolve, 100))
        const after = await health(port)
        assert.equal(after.requests.in_flight, 0, 'slot returned after the timeout')
    })
})

test('hung calls filling the cap do not leave the server shedding permanently', async (t) => {
    await withServer(t, async (port) => {
        // Fill every slot with calls that will never complete on their own.
        const stuck = [settle(callHangingTool(port)), settle(callHangingTool(port))]

        await new Promise((resolve) => setTimeout(resolve, 300))
        const duringOverload = await fetch(`http://127.0.0.1:${port}/mcp`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                accept: 'application/json, text/event-stream',
                'x-api-key': 'am_dummy',
            },
            body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'ping', params: {} }),
        })
        await duringOverload.text()
        assert.equal(duringOverload.status, 503, 'cap is enforced while genuinely full')

        await Promise.all(stuck)
        await new Promise((resolve) => setTimeout(resolve, 200))

        // Without the destroy-on-timeout path these slots would never come back
        // and every later request would 503 for the life of the process.
        const recovered = await fetch(`http://127.0.0.1:${port}/mcp`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                accept: 'application/json, text/event-stream',
                'x-api-key': 'am_dummy',
            },
            body: JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'ping', params: {} }),
        })
        await recovered.text()
        assert.equal(recovered.status, 200, 'server serves again once hung calls are reaped')
        assert.equal((await health(port)).requests.in_flight, 0)
    })
})

test('a client abort cancels the upstream call instead of orphaning it', async (t) => {
    await withServer(t, async (port) => {
        const controller = new AbortController()
        const call = settle(callHangingTool(port, controller.signal))

        await new Promise((resolve) => setTimeout(resolve, 400))
        assert.equal((await health(port)).requests.in_flight, 1, 'call is holding a slot')
        assert.equal(upstreamLive, 1, 'upstream call is open')

        controller.abort()
        await call
        await new Promise((resolve) => setTimeout(resolve, 300))

        // The counter alone is not the property worth asserting: before
        // cancellation was propagated, in_flight also read 0 here while the
        // upstream socket stayed open forever. agentmail-toolkit ignores
        // extra.signal, so the signal has to reach the SDK through the injected
        // fetch. If it does not, this is the assertion that catches it.
        assert.equal(upstreamLive, 0, 'upstream call was actually cancelled')
        assert.equal((await health(port)).requests.in_flight, 0, 'slot returned')
    })
})

test('an overloaded server rejects before parsing the body', async (t) => {
    await withServer(t, async (port) => {
        // 11 MB, past the 10 MB express.json ceiling. Which status comes back
        // tells us whether body parsing ran before or after the admission gate.
        const oversized = JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'ping',
            params: { pad: 'x'.repeat(11 * 1024 * 1024) },
        })
        const post = (body) =>
            fetch(`http://127.0.0.1:${port}/mcp`, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    accept: 'application/json, text/event-stream',
                    'x-api-key': 'am_dummy',
                },
                body,
            })

        // Healthy: the ceiling still applies, so route-scoping the parser did not
        // quietly drop the 10 MB limit.
        const healthy = await post(oversized)
        await healthy.text()
        assert.equal(healthy.status, 413, 'oversized bodies are still rejected when healthy')

        // Overloaded: every slot held by a stuck call.
        const stuck = [settle(callHangingTool(port)), settle(callHangingTool(port))]
        await new Promise((resolve) => setTimeout(resolve, 300))

        const shed = await post(oversized)
        await shed.text()
        // 413 here would mean the 11 MB was parsed before admission could shed
        // it — precisely the unbounded cost that piles up during a retry storm.
        assert.equal(shed.status, 503, 'shed before spending anything on the body')

        await Promise.all(stuck)
    })
})

test.after(() => {
    hangingUpstream.close()
})
