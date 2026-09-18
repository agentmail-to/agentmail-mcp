import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'

// A stand-in AgentMail API whose answer each test chooses. The shape that
// matters is the new-sender recipient ramp's: an immediate 429 whose Retry-After
// is the time left in the quota window (up to an hour), with the explanation
// and the remedy in the body. The SDK's fetcher retries 429s and sleeps
// min(Retry-After, 60 s) before each retry, so unless the server opts out of
// retries that answer never reaches the caller: the tool call sleeps through
// the request budget, the connection is destroyed, and the client sees a
// timeout instead of the cap.
const rampBody = {
    name: 'RateLimitError',
    code: 'limit_exceeded',
    message:
        'New account recipient limit exceeded: this organization may email at most 5 distinct recipients in its first hour (20 in its first day). The limit rises to 20 at 2026-09-17T12:00:00.000Z and lifts at 2026-09-24T11:00:00.000Z.',
    fix: 'Reply to a sender this inbox already corresponds with, wait for the window to reset, or upgrade the plan.',
}
const RAMP_RETRY_AFTER_SECONDS = 3000

let upstreamReply = { status: 429, headers: { 'retry-after': String(RAMP_RETRY_AFTER_SECONDS) }, body: rampBody }
let upstreamRequests = 0
const upstream = createServer((req, res) => {
    upstreamRequests++
    req.resume()
    req.on('end', () => {
        res.writeHead(upstreamReply.status, { 'content-type': 'application/json', ...upstreamReply.headers })
        res.end(typeof upstreamReply.body === 'string' ? upstreamReply.body : JSON.stringify(upstreamReply.body))
    })
})
await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))

process.env.AGENTMAIL_MCP_NO_LISTEN = '1'
process.env.AGENTMAIL_API_URL = `http://127.0.0.1:${upstream.address().port}`
// The hosted budget is 30 s. The 1 s floor keeps the test fast without changing
// the shape: any retry sleep is longer than this.
const BUDGET_MS = 1000
process.env.AGENTMAIL_REQUEST_TIMEOUT_MS = String(BUDGET_MS)
const { app } = await import('../packages/server/build/index.js')

async function withServer(t, fn) {
    const server = app.listen(0)
    t.after(() => {
        server.close()
    })
    await new Promise((resolve) => server.once('listening', resolve))
    return fn(server.address().port)
}

/**
 * Call one tool and return what the client actually got. A destroyed connection
 * (the timeout path) surfaces as a fetch or body error, which is reported rather
 * than thrown so the assertions can name it.
 */
async function callTool(port, name, args) {
    const started = Date.now()
    try {
        const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                accept: 'application/json, text/event-stream',
                'x-api-key': 'am_dummy',
            },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'tools/call',
                params: { name, arguments: args },
            }),
        })
        const text = await res.text()
        // StreamableHTTP answers tools/call as an SSE stream; the JSON-RPC
        // response is the last data line.
        const messages = text
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => JSON.parse(line.slice('data:'.length)))
        return { status: res.status, message: messages.at(-1), elapsedMs: Date.now() - started }
    } catch (error) {
        return { destroyed: true, error: String(error), elapsedMs: Date.now() - started }
    }
}

/** The tool result's text, after checking the call came back as an error result at all. */
function errorText(reply) {
    assert.equal(reply.destroyed, undefined, `connection was destroyed after ${reply.elapsedMs} ms: ${reply.error}`)
    assert.equal(reply.status, 200)
    assert.equal(reply.message?.result?.isError, true, JSON.stringify(reply.message))
    // Well inside the request budget: nothing slept on Retry-After.
    assert.ok(reply.elapsedMs < BUDGET_MS, `took ${reply.elapsedMs} ms`)
    assert.equal(upstreamRequests, 1, 'the SDK did not retry')
    return reply.message.result.content.map((part) => part.text).join('\n')
}

// One toolkit tool that writes and one that reads.
const calls = [
    ['send_message', { inboxId: 'agent@example.com', to: ['first@example.com'], subject: 'hello', text: 'hello' }],
    ['list_inboxes', {}],
]

test.beforeEach(() => {
    upstreamRequests = 0
    upstreamReply = { status: 429, headers: { 'retry-after': String(RAMP_RETRY_AFTER_SECONDS) }, body: rampBody }
})

test.after(() => {
    // Keep-alive sockets from the SDK's fetch would otherwise hold the process
    // open past the runner's completion.
    upstream.closeAllConnections()
    upstream.close()
})

for (const [name, args] of calls) {
    test(`${name} rejected by the recipient ramp returns the API explanation, not a timeout`, async (t) => {
        await withServer(t, async (port) => {
            const text = errorText(await callTool(port, name, args))
            assert.ok(text.includes(rampBody.message), `API message missing from: ${text}`)
            assert.ok(text.includes(rampBody.fix), `API fix missing from: ${text}`)
            assert.match(text, /HTTP 429/)
        })
    })
}

test('get_thread, the hand-written path with its own request options on the same client, surfaces the cap too', async (t) => {
    await withServer(t, async (port) => {
        const text = errorText(await callTool(port, 'get_thread', { inboxId: 'agent@example.com', threadId: 'thread_1' }))
        // This path reports through toolFailure, which prints the SDK's own
        // "Status code / Body" message rather than the toolkit's one-line
        // rendering, so the body is checked for its fields rather than a format.
        assert.ok(text.includes(rampBody.message), `API message missing from: ${text}`)
        assert.ok(text.includes(rampBody.fix), `API fix missing from: ${text}`)
        assert.match(text, /429/)
    })
})

test('a 429 without a fix still surfaces at once, with the generic rate-limit guidance', async (t) => {
    upstreamReply = {
        status: 429,
        headers: { 'retry-after': '120' },
        body: { name: 'RateLimitError', message: 'Too many requests' },
    }
    await withServer(t, async (port) => {
        const text = errorText(await callTool(port, 'list_inboxes', {}))
        assert.match(text, /Too many requests/)
        assert.match(text, /HTTP 429/)
        assert.match(text, /wait before retrying/)
    })
})

test('a 503 with a long Retry-After surfaces at once too, since the same retry sleep applies', async (t) => {
    upstreamReply = {
        status: 503,
        headers: { 'retry-after': '120' },
        body: { name: 'ServiceUnavailableError', message: 'Service temporarily unavailable' },
    }
    await withServer(t, async (port) => {
        const text = errorText(await callTool(port, 'list_inboxes', {}))
        assert.match(text, /Service temporarily unavailable/)
        assert.match(text, /HTTP 503/)
    })
})

test('a 500 with no Retry-After is not retried either: the caller decides', async (t) => {
    upstreamReply = { status: 500, headers: {}, body: { name: 'InternalError', message: 'Something broke' } }
    await withServer(t, async (port) => {
        const text = errorText(await callTool(port, 'list_inboxes', {}))
        assert.match(text, /Something broke/)
        assert.match(text, /HTTP 500/)
    })
})

test('a 404 was never retried and still is not', async (t) => {
    upstreamReply = { status: 404, headers: {}, body: { name: 'NotFoundError', message: 'Inbox not found' } }
    await withServer(t, async (port) => {
        const text = errorText(await callTool(port, 'list_inboxes', {}))
        assert.match(text, /Inbox not found/)
        assert.match(text, /HTTP 404/)
    })
})

test('a non-JSON 429, as a proxy in front of the API would send, surfaces at once and bounded', async (t) => {
    const page = `<html><body>${'Rate limited. '.repeat(400)}</body></html>`
    upstreamReply = { status: 429, headers: { 'retry-after': '600', 'content-type': 'text/html' }, body: page }
    await withServer(t, async (port) => {
        const text = errorText(await callTool(port, 'list_inboxes', {}))
        assert.match(text, /Rate limited\./)
        assert.match(text, /HTTP 429/)
        assert.ok(text.length < page.length / 2, `error text was not bounded: ${text.length} chars`)
    })
})

test('a successful answer is unaffected', async (t) => {
    upstreamReply = { status: 200, headers: {}, body: { count: 0, limit: 10, inboxes: [] } }
    await withServer(t, async (port) => {
        const reply = await callTool(port, 'list_inboxes', {})
        assert.equal(reply.destroyed, undefined)
        assert.equal(reply.message?.result?.isError, false, JSON.stringify(reply.message))
        assert.deepEqual(reply.message.result.structuredContent.inboxes, [])
        assert.equal(upstreamRequests, 1)
    })
})

// The change above rests on what the SDK does with a 429 when retries are left
// at their default. Pin that here, against the SDK the server actually resolves,
// so a future SDK that stops retrying 429s or stops honoring Retry-After shows
// up as a failing test rather than a stale comment.
const { AgentMailClient } = createRequire(new URL('../packages/server/package.json', import.meta.url))('agentmail')

function rampFetch() {
    const calls = []
    const fetchFn = async (url) => {
        calls.push(String(url))
        return new Response(JSON.stringify(rampBody), {
            status: 429,
            headers: { 'content-type': 'application/json', 'retry-after': String(RAMP_RETRY_AFTER_SECONDS) },
        })
    }
    return { calls, fetchFn }
}

test('SDK contract: by default a 429 is retried twice, sleeping 60 s (the cap) on a long Retry-After', async (t) => {
    mock.timers.enable({ apis: ['setTimeout'] })
    t.after(() => mock.timers.reset())
    const { calls, fetchFn } = rampFetch()
    const client = new AgentMailClient({ apiKey: 'am_dummy', environment: { http: 'http://upstream.test', websockets: '' }, fetch: fetchFn })

    let settled
    const pending = client.inboxes.list().then(
        () => {
            settled = 'resolved'
        },
        (error) => {
            settled = error
        }
    )
    // Let the first request and its response parsing run.
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(calls.length, 1)
    assert.match(calls[0], /\/v0\/inboxes$/)
    assert.equal(settled, undefined, 'still sleeping on Retry-After')

    mock.timers.tick(59_000)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(calls.length, 1, 'no retry before the 60 s cap')

    mock.timers.tick(1_000)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(calls.length, 2, 'first retry at 60 s, not at the 3000 s Retry-After')

    mock.timers.tick(60_000)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(calls.length, 3, 'second retry at 120 s')

    await pending
    assert.equal(settled?.statusCode, 429)
    assert.deepEqual(settled?.body, rampBody)
})

test('SDK contract: a 503 with Retry-After takes the same sleep, so the opt-out has to cover 5xx too', async (t) => {
    mock.timers.enable({ apis: ['setTimeout'] })
    t.after(() => mock.timers.reset())
    const calls = []
    const client = new AgentMailClient({
        apiKey: 'am_dummy',
        environment: { http: 'http://upstream.test', websockets: '' },
        fetch: async (url) => {
            calls.push(String(url))
            return new Response('{"message":"Service temporarily unavailable"}', {
                status: 503,
                headers: { 'content-type': 'application/json', 'retry-after': '120' },
            })
        },
    })
    const pending = client.inboxes.list().catch((error) => error)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(calls.length, 1)

    mock.timers.tick(59_000)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(calls.length, 1, 'no retry before the 60 s cap')

    mock.timers.tick(1_000)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(calls.length, 2, 'retried at the 60 s cap, not the 120 s Retry-After')

    mock.timers.tick(60_000)
    const error = await pending
    assert.equal(calls.length, 3)
    assert.equal(error.statusCode, 503)
})

test('SDK contract: maxRetries 0 makes the same 429 surface after one request', async () => {
    const { calls, fetchFn } = rampFetch()
    const client = new AgentMailClient({
        apiKey: 'am_dummy',
        environment: { http: 'http://upstream.test', websockets: '' },
        fetch: fetchFn,
        maxRetries: 0,
    })
    await assert.rejects(client.inboxes.list(), (error) => error.statusCode === 429)
    assert.equal(calls.length, 1)
})
