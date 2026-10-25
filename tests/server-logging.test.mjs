import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

// A stand-in AgentMail API whose answer each test chooses, so tool calls fail
// the way production's do: an error body with a name, code and message, and
// the API Gateway request id header.
let upstreamReply
const upstream = createServer((req, res) => {
    req.resume()
    req.on('end', async () => {
        if (upstreamReply.delayMs) await new Promise((resolve) => setTimeout(resolve, upstreamReply.delayMs))
        res.writeHead(upstreamReply.status, {
            'content-type': 'application/json',
            'apigw-requestid': upstreamReply.requestId ?? 'Jx3sYhKpoAMEb3Q=',
        })
        res.end(JSON.stringify(upstreamReply.body))
    })
})
await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))

process.env.AGENTMAIL_MCP_NO_LISTEN = '1'
process.env.AGENTMAIL_API_URL = `http://127.0.0.1:${upstream.address().port}`
const { app, installLogging, emitStats, logSdkError, apiErrorFields } = await import('../packages/server/build/index.js')
const { setLogSink, resetSampling, redact, hashId, log } = await import('../packages/server/build/log.js')

// What production runs at startup: console output, agentmail-toolkit's
// included, goes through the logger.
installLogging()

const API_KEY = 'am_us_0123456789abcdef0123456789abcdef'
const notFound = {
    name: 'NotFoundError',
    code: 'not_found',
    message: 'Inbox not found',
    // The real body's remedy text, which made toolkit 0.16 truncate it to unparseable JSON.
    fix: 'No inbox with the given identifier is visible to this credential. '.repeat(10),
    docs: 'https://docs.agentmail.to/errors#not_found',
}

let lines = []
const restoreSink = setLogSink((_level, line) => lines.push(line))

test.beforeEach(() => {
    // Close the previous test's stats window so each test counts only its own.
    emitStats()
    lines = []
    resetSampling()
    upstreamReply = { status: 404, body: notFound }
})

test.after(() => {
    restoreSink()
    upstream.closeAllConnections()
    upstream.close()
})

const parsed = () => lines.map((line) => JSON.parse(line))
const events = (name) => parsed().filter((line) => line.event === name)

async function withServer(t, fn) {
    const server = app.listen(0)
    t.after(() => server.close())
    await new Promise((resolve) => server.once('listening', resolve))
    return fn(server.address().port)
}

async function rpc(port, body, headers = {}) {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
        body: JSON.stringify(body),
    })
    const text = await res.text()
    const data = text
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => JSON.parse(line.slice('data:'.length)))
        .at(-1)
    return { status: res.status, message: data ?? (text ? JSON.parse(text) : undefined) }
}

const callTool = (port, name, args, headers = { 'x-api-key': API_KEY }) =>
    rpc(port, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, headers)

test('every line is one JSON object with ts, level, event and machine', async (t) => {
    await withServer(t, async (port) => {
        await rpc(port, { jsonrpc: '2.0', id: 1, method: 'ping' })
        await callTool(port, 'list_threads', { inboxId: 'agent@agentmail.to' })
        console.error('a library prints an object', { nested: { list: [1, 2, 3] }, text: 'two\nlines' }, new Error('and an error'))
        emitStats()
    })
    assert.ok(lines.length >= 3)
    for (const line of lines) {
        assert.equal(line.includes('\n'), false, line)
        const entry = JSON.parse(line)
        assert.match(entry.ts, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/)
        assert.ok(['debug', 'info', 'warn', 'error'].includes(entry.level))
        assert.equal(typeof entry.event, 'string')
        assert.equal(typeof entry.machine, 'string')
    }
    const [consoleLine] = events('console')
    assert.equal(consoleLine.level, 'error')
    assert.match(consoleLine.msg, /a library prints an object .*and an error/)
})

test('a toolkit API 4xx is one info line with the API error, request context and the API request id, never the body', async (t) => {
    await withServer(t, async (port) => {
        const reply = await callTool(port, 'list_threads', { inboxId: 'agent@agentmail.to' }, {
            'x-api-key': API_KEY,
            'user-agent': 'Cursor/1.7.2 (darwin arm64)',
        })
        // What the client sees is the toolkit's, unchanged.
        assert.equal(reply.message.result.isError, true)
        assert.match(reply.message.result.content[0].text, /Inbox not found/)
    })
    const toolLines = events('tool.error')
    assert.equal(toolLines.length, 1, lines.join('\n'))
    const [line] = toolLines
    assert.equal(line.level, 'info')
    assert.equal(line.tool, 'list_threads')
    assert.equal(line.mcp_method, 'tools/call')
    assert.equal(line.kind, '404')
    assert.equal(line.api_status, 404)
    assert.equal(line.api_error, 'NotFoundError')
    assert.equal(line.api_code, 'not_found')
    assert.equal(line.api_message, 'Inbox not found')
    assert.equal(line.api_request_id, 'Jx3sYhKpoAMEb3Q=')
    assert.equal(line.auth, 'api_key')
    assert.equal(line.actor, hashId(API_KEY))
    assert.equal(line.ua, 'Cursor/1.7.2 (darwin arm64)')
    assert.match(line.req_id, /^[0-9a-f]{16}$/)
    assert.equal(typeof line.duration_ms, 'number')
    assert.equal('body' in line, false)
    assert.equal(JSON.stringify(lines).includes('No inbox with the given identifier'), false)
    // agentmail-toolkit 0.16's own console.error went to the same line, not out on its own.
    assert.deepEqual(events('console'), [])
})

test('an API 5xx is an error line; email addresses in API messages are masked', async (t) => {
    await withServer(t, async (port) => {
        upstreamReply = { status: 500, body: { name: 'InternalServerError', message: 'boom for someone@example.com' } }
        await callTool(port, 'list_inboxes', {})
        upstreamReply = {
            status: 403,
            body: {
                name: 'MessageRejectedError',
                code: 'message_rejected',
                message: 'Message rejected: Recipient(s) blocked: rpm389@gmail.com (suppressed by AgentMail: Unsubscribed)',
            },
        }
        await callTool(port, 'send_message', { inboxId: 'agent@agentmail.to', to: ['rpm389@gmail.com'], subject: 's', text: 't' })
    })
    const [serverError, rejected] = events('tool.error')
    assert.equal(serverError.level, 'error')
    assert.equal(serverError.api_status, 500)
    assert.equal(serverError.api_message, 'boom for <email>')
    assert.equal(rejected.level, 'info')
    assert.equal(rejected.api_message, 'Message rejected: Recipient(s) blocked: <email> (suppressed by AgentMail: Unsubscribed)')
    assert.equal(JSON.stringify(lines).includes('@gmail.com'), false)
    assert.equal(JSON.stringify(lines).includes('@example.com'), false)
})

test('get_thread failures are logged and the client still gets the same text', async (t) => {
    await withServer(t, async (port) => {
        upstreamReply = { status: 500, body: { name: 'InternalServerError', message: 'boom' } }
        const reply = await callTool(port, 'get_thread', { inboxId: 'agent@agentmail.to', threadId: 'thread_1' })
        assert.equal(reply.message.result.isError, true)
        assert.match(reply.message.result.content[0].text, /^Status code: 500/)
    })
    const [line] = events('tool.error')
    assert.equal(line.level, 'error')
    assert.equal(line.tool, 'get_thread')
    assert.equal(line.api_status, 500)
    assert.equal(line.api_error, 'InternalServerError')
})

test('repeated 4xx failures are sampled; the stats line counts every one and what was held back', async (t) => {
    await withServer(t, async (port) => {
        for (let i = 0; i < 8; i++) await callTool(port, 'list_threads', { inboxId: 'agent@agentmail.to' })
        emitStats()
    })
    assert.equal(events('tool.error').length, 5)
    const [stats] = events('stats')
    assert.equal(stats.tool_errors['404'], 8)
    assert.equal(stats.suppressed['tool.error'], 3)
    assert.equal(stats.requests['tools/call 200'], 8)
    assert.equal(stats.auth.api_key, 8)
    // The stats line belongs to no request.
    assert.equal('req_id' in stats, false)
})

test('concurrent requests keep their own context', async (t) => {
    await withServer(t, async (port) => {
        upstreamReply = { status: 404, body: notFound, delayMs: 150 }
        const slow = callTool(port, 'list_threads', { inboxId: 'slow@agentmail.to' })
        await new Promise((resolve) => setTimeout(resolve, 20))
        upstreamReply = { status: 404, body: notFound }
        await callTool(port, 'list_inboxes', {}, { 'x-api-key': 'am_us_another_key_0123456789abcdef' })
        await slow
    })
    const byTool = Object.fromEntries(events('tool.error').map((line) => [line.tool, line]))
    assert.notEqual(byTool.list_threads.req_id, byTool.list_inboxes.req_id)
    assert.equal(byTool.list_threads.actor, hashId(API_KEY))
    assert.equal(byTool.list_inboxes.actor, hashId('am_us_another_key_0123456789abcdef'))
    assert.ok(byTool.list_threads.duration_ms >= 150)
})

test('client protocol rejections are one info line with their kind and no stack; anything else keeps its frames', async (t) => {
    await withServer(t, async (port) => {
        const reply = await rpc(
            port,
            {
                jsonrpc: '2.0',
                id: 1,
                method: 'initialize',
                params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mcp', version: '0.1.0' } },
            },
            { 'x-api-key': API_KEY, 'mcp-protocol-version': '2026-07-28' }
        )
        assert.equal(reply.status, 400)
    })
    const [rejected] = events('mcp.rejected')
    assert.equal(rejected.level, 'info')
    assert.equal(rejected.rejection, 'initialize-with-modern-header')
    assert.equal(rejected.client_name, 'mcp')
    assert.equal(rejected.client_version, '0.1.0')
    assert.equal('stack' in rejected, false)

    logSdkError('handler', new Error('factory exploded'))
    const [unexpected] = events('mcp.error')
    assert.equal(unexpected.level, 'error')
    assert.equal(unexpected.error, 'factory exploded')
    assert.match(unexpected.stack, /server-logging\.test\.mjs/)
})

test('credentials and addresses never reach a line, wherever a client puts them', async (t) => {
    const jwt = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyXzEyMyJ9.c2lnbmF0dXJl'
    await withServer(t, async (port) => {
        await rpc(
            port,
            {
                jsonrpc: '2.0',
                id: 1,
                method: 'initialize',
                params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: `evil ${jwt}`, version: 'me@example.com' } },
            },
            { 'mcp-protocol-version': '2026-07-28', 'user-agent': `curl ${API_KEY}` }
        )
        await fetch(`http://127.0.0.1:${port}/mcp?apiKey=${API_KEY}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_inboxes', arguments: {} } }),
        }).then((res) => res.text())
    })
    const all = lines.join('\n')
    assert.ok(lines.length > 0)
    for (const secret of [jwt, API_KEY, 'me@example.com']) assert.equal(all.includes(secret), false, secret)
    assert.equal(events('mcp.rejected')[0].client_name, 'evil <jwt>')
})

test('redact masks addresses, keys and tokens, and turns Clerk ids into their pseudonym', () => {
    assert.equal(redact('to a.b+c@sub.example.co.uk now'), 'to <email> now')
    assert.equal(redact('key am_us_abcdef0123456789 here'), 'key am_<redacted> here')
    assert.equal(redact('Authorization: Bearer abc.def-ghi'), 'Authorization: Bearer <redacted>')
    assert.equal(redact('sk_live_abcdef123'), 'sk_<redacted>')
    assert.equal(redact('token eyJhbGciOi.eyJzdWIiOi.sig'), 'token <jwt>')
    assert.equal(
        redact('User user_2abcdefghijklmnopqrstuv is not in org_2abcdefghijklmnopqrstuv'),
        `User user:${hashId('user_2abcdefghijklmnopqrstuv')} is not in org:${hashId('org_2abcdefghijklmnopqrstuv')}`
    )
    assert.ok(redact('x'.repeat(10_000)).length <= 2001)
})

test('hashId is a stable 12-character pseudonym that matches no plain hash of the value', () => {
    assert.match(hashId(API_KEY), /^[0-9a-f]{12}$/)
    assert.equal(hashId(API_KEY), hashId(API_KEY))
    assert.equal(hashId(API_KEY), createHash('sha256').update(`agentmail-mcp:${API_KEY}`).digest('hex').slice(0, 12))
    assert.notEqual(hashId(API_KEY), createHash('sha256').update(API_KEY).digest('hex').slice(0, 12))
})

test('toolkit 0.16 bodies over 500 characters arrive as cut JSON text and still yield their fields', () => {
    const cut = `${JSON.stringify(notFound).slice(0, 500)}...[truncated]`
    assert.deepEqual(apiErrorFields(cut), { api_error: 'NotFoundError', api_code: 'not_found', api_message: 'Inbox not found' })
    assert.deepEqual(
        apiErrorFields({ name: 'ValidationError', message: 'Request validation failed', errors: [{ path: ['to', 0], message: 'Invalid email' }, { path: 'subject' }] }),
        { api_error: 'ValidationError', api_message: 'Request validation failed', api_fields: ['to.0', 'subject'] }
    )
})

test('toolkit attachment skips become one line with a reason code', () => {
    console.error('[agentmail-toolkit] attachment too large to extract, skipping', { attachmentId: 'att_1', size: 26_000_000 })
    const [line] = events('tool.attachment_not_extracted')
    assert.equal(line.level, 'info')
    assert.equal(line.reason, 'too_large')
    assert.equal(line.size, 26_000_000)
    assert.deepEqual(events('console'), [])
})

test("toolkit 0.17's one-line default is read the same way, should a bump forget the logger", () => {
    // What 0.17 prints with no logger. Outside a request nothing waits for the
    // tool result, so the failure is logged at once.
    const body = `${JSON.stringify(notFound).slice(0, 500)}...[truncated]`
    console.warn(
        `[agentmail-toolkit] tool error ${JSON.stringify({ tool: 'list_threads', message: 'Inbox not found (HTTP 404)', statusCode: 404, body })}`
    )
    console.warn(
        `[agentmail-toolkit] attachment not extracted ${JSON.stringify({ message: 'too large', reason: 'too_large', attachmentId: 'att_1', size: 9 })}`
    )
    assert.deepEqual(events('console'), [])
    const [failure] = events('tool.error')
    assert.equal(failure.tool, 'list_threads')
    assert.equal(failure.kind, '404')
    assert.equal(failure.api_error, 'NotFoundError')
    assert.equal(failure.api_message, 'Inbox not found')
    assert.equal(events('tool.attachment_not_extracted')[0].reason, 'too_large')
})

test('a burst past the process-wide ceiling is dropped and counted, and the stats line still goes out', () => {
    for (let i = 0; i < 150; i++) log('info', 'test.burst', { i })
    emitStats()
    assert.equal(events('test.burst').length, 100)
    assert.equal(events('stats')[0].dropped, 50)
})

test('the server logs only through log.ts', async () => {
    const source = await readFile(new URL('../packages/server/src/index.ts', import.meta.url), 'utf8')
    assert.deepEqual(source.match(/\bconsole\.(log|info|warn|error|debug)\(/g) ?? [], [])
})
