import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'

// A stand-in AgentMail API that records what each send carried and answers
// with a fixed message, optionally flagged as an idempotent replay.
let upstreamRequests = []
let replay = false
const upstream = createServer((req, res) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
        upstreamRequests.push({ method: req.method, url: req.url, headers: req.headers, body })
        if (req.method === 'GET') {
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ count: 0, limit: 10, inboxes: [] }))
            return
        }
        res.writeHead(200, {
            'content-type': 'application/json',
            ...(replay ? { 'idempotent-replayed': 'true' } : {}),
        })
        res.end(JSON.stringify({ message_id: 'msg_original', thread_id: 'thread_1' }))
    })
})
await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))

process.env.AGENTMAIL_MCP_NO_LISTEN = '1'
process.env.AGENTMAIL_API_URL = `http://127.0.0.1:${upstream.address().port}`
const { app, sendIdempotencyKeyFor } = await import('../packages/server/build/index.js')

const server = app.listen(0)
await new Promise((resolve) => server.once('listening', resolve))
const { port } = server.address()
test.after(() => {
    server.close()
    upstream.closeAllConnections()
    upstream.close()
})
test.beforeEach(() => {
    upstreamRequests = []
    replay = false
})

async function callTool(name, args) {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            'x-api-key': 'am_dummy',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    })
    const text = await res.text()
    const messages = text
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => JSON.parse(line.slice('data:'.length)))
    return messages.at(-1).result
}

const sendArgs = { inboxId: 'agent@example.com', to: ['first@example.com'], subject: 'hello', text: 'hello' }

test('the same send carries the same content-hash Idempotency-Key on every attempt, without client cooperation', async () => {
    const first = await callTool('send_message', sendArgs)
    const second = await callTool('send_message', sendArgs)
    assert.equal(first.isError, false, JSON.stringify(first))
    assert.equal(second.isError, false)
    assert.equal(upstreamRequests.length, 2)
    const [a, b] = upstreamRequests.map((r) => r.headers['idempotency-key'])
    assert.match(a, /^mcp-[0-9a-f]{64}$/)
    assert.equal(a, b, 'a retry of the same call dedups at the API')
    assert.equal(first.structuredContent.replayed, undefined, 'no replay was reported')
})

test('a different body gets a different key', async () => {
    await callTool('send_message', sendArgs)
    await callTool('send_message', { ...sendArgs, subject: 'hello again' })
    const [a, b] = upstreamRequests.map((r) => r.headers['idempotency-key'])
    assert.notEqual(a, b)
})

test('an explicit idempotencyKey overrides the hash and never reaches the API body', async () => {
    const result = await callTool('send_message', { ...sendArgs, idempotencyKey: 'order-42' })
    assert.equal(result.isError, false, JSON.stringify(result))
    const [req] = upstreamRequests
    assert.equal(req.headers['idempotency-key'], 'order-42')
    assert.ok(!req.body.includes('idempotencyKey'), req.body)
    assert.ok(!req.body.includes('idempotency_key'), req.body)
})

test('a malformed idempotencyKey is rejected before anything is sent', async () => {
    const result = await callTool('send_message', { ...sendArgs, idempotencyKey: 'has spaces' })
    assert.equal(result.isError, true)
    assert.equal(upstreamRequests.length, 0)
})

test('a replay reported by the API is surfaced in the tool result', async () => {
    replay = true
    const result = await callTool('send_message', sendArgs)
    assert.equal(result.isError, false, JSON.stringify(result))
    assert.equal(result.structuredContent.replayed, true)
    assert.equal(result.structuredContent.messageId, 'msg_original')
    const text = result.content.map((part) => part.text).join('\n')
    assert.match(text, /Replayed/)
    assert.match(text, /idempotencyKey/)
    assert.match(text, /"replayed":true/)
})

test('reply, forward, and send_draft are covered; reads are not', async () => {
    await callTool('reply_to_message', { inboxId: 'agent@example.com', messageId: 'msg_1', text: 'thanks' })
    await callTool('forward_message', { inboxId: 'agent@example.com', messageId: 'msg_1', to: ['x@example.com'] })
    await callTool('send_draft', { inboxId: 'agent@example.com', draftId: 'draft_1' })
    await callTool('list_inboxes', {})
    const keys = upstreamRequests.map((r) => [r.url, r.headers['idempotency-key']])
    assert.equal(keys.length, 4, JSON.stringify(keys))
    for (const [url, key] of keys.slice(0, 3)) assert.match(key ?? '', /^mcp-[0-9a-f]{64}$/, url)
    assert.equal(keys[3][1], undefined, 'GET list_inboxes carries no key')
})

test('sendIdempotencyKeyFor keys only the send routes', () => {
    const base = 'https://api.agentmail.to'
    const key = (path, method = 'POST', body = '{"a":1}') => sendIdempotencyKeyFor(`${base}${path}`, method, body)
    assert.match(key('/v0/inboxes/a%40b.com/messages/send'), /^mcp-/)
    assert.match(key('/v0/inboxes/a/messages/msg_1/reply'), /^mcp-/)
    assert.match(key('/v0/inboxes/a/messages/msg_1/reply-all'), /^mcp-/)
    assert.match(key('/v0/inboxes/a/messages/msg_1/forward'), /^mcp-/)
    assert.match(key('/v0/inboxes/a/drafts/d_1/send'), /^mcp-/)
    assert.equal(key('/v0/inboxes/a/messages/send', 'GET'), undefined)
    assert.equal(key('/v0/inboxes/a/drafts'), undefined, 'create_draft is not a send')
    assert.equal(key('/v0/inboxes'), undefined)
    assert.equal(key('not a url'), undefined)
    assert.equal(key('/v0/inboxes/a/messages/send'), key('/v0/inboxes/a/messages/send'), 'deterministic')
    assert.notEqual(key('/v0/inboxes/a/messages/send'), key('/v0/inboxes/b/messages/send'), 'inbox is part of the key')
})
