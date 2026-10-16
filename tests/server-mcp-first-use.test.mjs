import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { generateKeyPairSync } from 'node:crypto'
import { createRequire } from 'node:module'

// What the AgentMail API needs to record each organization's first MCP use: the OAuth client the
// user authorized, as `mcp_client_id` on the console JWT a tool call signs (never on the bootstrap
// JWT), and the MCP client's own User-Agent, relayed on every API request whichever credential it
// holds. The API is a stand-in that records the headers it received.

let apiRequests = []
const api = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
        apiRequests.push({ method: req.method, url: req.url, headers: req.headers })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(req.url.startsWith('/v0/mcp/events') ? { events: [] } : { count: 0, inboxes: [] }))
    })
})
await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve))

const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
process.env.CONSOLE_JWT_PRIVATE_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' })
process.env.AGENTMAIL_MCP_NO_LISTEN = '1'
process.env.AGENTMAIL_API_URL = `http://127.0.0.1:${api.address().port}`
const { app, signConsoleJwt, relayedUserAgent, oauthClientName, MCP_USER_AGENT_HEADER } = await import(
    '../packages/server/build/index.js'
)

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
})

const payload = (jwt) => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString())

test('a tool call’s console JWT names the OAuth client and its name; the bootstrap JWT does not', async () => {
    const toolCall = payload(await signConsoleJwt('internal_org', 'Y0enFZG3FF8IFxZr', 'Cursor'))
    assert.equal(toolCall.organizationId, 'internal_org')
    assert.equal(toolCall.mcp_client_id, 'Y0enFZG3FF8IFxZr')
    assert.equal(toolCall.mcp_client_name, 'Cursor')

    // Before the name lookup answers, the client id goes alone.
    const unnamed = payload(await signConsoleJwt('internal_org', 'Y0enFZG3FF8IFxZr'))
    assert.equal(unnamed.mcp_client_id, 'Y0enFZG3FF8IFxZr')
    assert.equal('mcp_client_name' in unnamed, false)
    // A name never travels without its client id.
    assert.equal('mcp_client_name' in payload(await signConsoleJwt('internal_org', undefined, 'Cursor')), false)

    const bootstrap = payload(await signConsoleJwt('org_clerk'))
    assert.equal(bootstrap.organizationId, 'org_clerk')
    assert.equal('mcp_client_id' in bootstrap, false)
})

test('the relayed user agent drops what fetch refuses in a header and is capped', () => {
    assert.equal(relayedUserAgent('Cursor/1.7.0 (darwin arm64)'), 'Cursor/1.7.0 (darwin arm64)')
    assert.equal(relayedUserAgent(' claude-code/2.1\t\u0000  '), 'claude-code/2.1')
    assert.equal(relayedUserAgent('Clïent/1'), 'Clïent/1')
    assert.equal(relayedUserAgent('x'.repeat(500)).length, 200)
    assert.equal(relayedUserAgent(['first/1', 'second/2']), 'first/1')
    assert.equal(relayedUserAgent('\u0007 中'), undefined)
    assert.equal(relayedUserAgent(undefined), undefined)
})

async function callTool(userAgent) {
    const res = await fetch(url, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            'x-api-key': 'am_test_key',
            'user-agent': userAgent,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_inboxes', arguments: {} } }),
    })
    await res.text()
    assert.equal(res.status, 200)
}

test('an API-key tool call relays the client’s user agent to the API', async () => {
    await callTool('Cursor/1.7.0')
    await callTool('Windsurf/1.2 beta')

    const relayed = apiRequests.filter((r) => r.url.startsWith('/v0/inboxes')).map((r) => r.headers[MCP_USER_AGENT_HEADER])
    assert.deepEqual(relayed, ['Cursor/1.7.0', 'Windsurf/1.2 beta'])
    // The API still sees the SDK as the caller; the relayed header is what names the client.
    assert.notEqual(apiRequests[0].headers['user-agent'], 'Cursor/1.7.0')
})

test('an events call relays it too', async () => {
    const res = await fetch(url, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            'x-api-key': 'am_test_key',
            'user-agent': 'chatgpt-connector/1.0',
            'mcp-protocol-version': '2026-07-28',
            'mcp-method': 'events/list',
        },
        body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'events/list',
            params: {
                _meta: {
                    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                    'io.modelcontextprotocol/clientInfo': { name: 'chatgpt-test', version: '1' },
                    'io.modelcontextprotocol/clientCapabilities': {},
                },
            },
        }),
    })
    await res.text()

    const events = apiRequests.find((r) => r.url === '/v0/mcp/events')
    assert.ok(events, JSON.stringify(apiRequests.map((r) => r.url)))
    assert.equal(events.headers[MCP_USER_AGENT_HEADER], 'chatgpt-connector/1.0')
})

// One lookup per client id per process, through stubbed dependencies.
function lookupFixture(answer) {
    const calls = []
    return {
        calls,
        deps: {
            listApplications: (clientId) => {
                calls.push(clientId)
                return answer(clientId)
            },
            cache: new Map(),
            pending: new Map(),
            waitMs: 50,
        },
    }
}

test('a client’s name is looked up once per process, and a client Clerk has none for is remembered too', async () => {
    const { calls, deps } = lookupFixture(async (clientId) => ({
        data: [
            { clientId: `${clientId}x`, name: 'Prefix match' },
            ...(clientId === 'known' ? [{ clientId, name: '  Cursor  ' }] : []),
        ],
    }))

    assert.equal(await oauthClientName('known', deps), 'Cursor')
    assert.equal(await oauthClientName('known', deps), 'Cursor')
    assert.equal(await oauthClientName('unknown', deps), undefined)
    assert.equal(await oauthClientName('unknown', deps), undefined)
    assert.deepEqual(calls, ['known', 'unknown'])
})

test('a failed lookup is asked again, and concurrent calls share one lookup', async () => {
    let fail = true
    const { calls, deps } = lookupFixture(async (clientId) => {
        if (fail) throw new Error('clerk 503')
        return { data: [{ clientId, name: 'Codex' }] }
    })

    assert.equal(await oauthClientName('flaky', deps), undefined)
    fail = false
    const [first, second] = await Promise.all([oauthClientName('flaky', deps), oauthClientName('flaky', deps)])
    assert.deepEqual([first, second], ['Codex', 'Codex'])
    assert.deepEqual(calls, ['flaky', 'flaky'])
})

test('a call waits only briefly for a slow lookup, and the next call has the name', async () => {
    let release
    const { deps } = lookupFixture(
        (clientId) =>
            new Promise((resolve) => {
                release = () => resolve({ data: [{ clientId, name: 'Claude Code (agentmail)' }] })
            })
    )

    const started = Date.now()
    assert.equal(await oauthClientName('slow', deps), undefined)
    assert.ok(Date.now() - started < 1_000)
    release()
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(await oauthClientName('slow', deps), 'Claude Code (agentmail)')
})

test('a name goes on whole up to the claim’s 1,000 UTF-16 units, and is cut there without splitting a pair', async () => {
    const names = {
        // 107 code points, 207 units: past what the API stores, so it records product unknown, as for a signup origin.
        stored_long: `Cursor ${'😀'.repeat(100)}`,
        emoji: '😀'.repeat(600),
        straddling: `${'x'.repeat(999)}😀`,
    }
    const { deps } = lookupFixture(async (clientId) => ({ data: [{ clientId, name: names[clientId] }] }))

    assert.equal(await oauthClientName('stored_long', deps), names.stored_long)
    assert.equal(await oauthClientName('emoji', deps), '😀'.repeat(500))
    assert.equal(await oauthClientName('straddling', deps), 'x'.repeat(999))
})

test('the Clerk SDK this server uses sends nameQuery as name_query', async () => {
    let seen
    const realFetch = globalThis.fetch
    // Stubbed before the SDK loads: it binds fetch when it is imported.
    globalThis.fetch = async (url) => {
        seen = new URL(String(url))
        return new Response(JSON.stringify({ data: [{ object: 'oauth_application', id: 'oa_1', client_id: 'C2nehWQ9vHAeRJc1', name: 'Cursor' }], total_count: 1 }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        })
    }
    try {
        const fromExpress = createRequire(createRequire(import.meta.url).resolve('../packages/server/node_modules/@clerk/express'))
        const { createClerkClient } = await import(fromExpress.resolve('@clerk/backend'))
        const page = await createClerkClient({ secretKey: 'sk_test_contract' }).oauthApplications.list({
            nameQuery: 'C2nehWQ9vHAeRJc1',
            limit: 10,
        })
        assert.equal(seen.pathname, '/v1/oauth_applications')
        assert.equal(seen.searchParams.get('name_query'), 'C2nehWQ9vHAeRJc1')
        assert.deepEqual({ clientId: page.data[0].clientId, name: page.data[0].name }, { clientId: 'C2nehWQ9vHAeRJc1', name: 'Cursor' })
    } finally {
        globalThis.fetch = realFetch
    }
})

