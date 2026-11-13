import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { generateKeyPairSync, verify } from 'node:crypto'

// An organization lives in one region and only that region's API knows it: an
// am_eu_ key gets 403 on every call to the US host, and the EU API verifies
// console JWTs against its own key. AGENTMAIL_API_URL is the US deployment, so
// an EU key's calls, and an EU organization's OAuth calls, go to the EU host
// instead. Two stand-in APIs record which one each call reached.

function standIn(region) {
    const requests = []
    const server = createServer((req, res) => {
        req.resume()
        req.on('end', () => {
            requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization })
            res.writeHead(200, { 'content-type': 'application/json' })
            const body = req.url.startsWith('/v0/mcp/')
                ? { events: [] }
                : req.url.startsWith('/v0/auth/internal-org')
                  ? { organization_id: `${region}_internal_org` }
                  : { count: 0, inboxes: [], region }
            res.end(JSON.stringify(body))
        })
    })
    return { server, requests }
}

const us = standIn('us')
const eu = standIn('eu')
await new Promise((resolve) => us.server.listen(0, '127.0.0.1', resolve))
await new Promise((resolve) => eu.server.listen(0, '127.0.0.1', resolve))

const usKey = generateKeyPairSync('ec', { namedCurve: 'P-256' })
const euKey = generateKeyPairSync('ec', { namedCurve: 'P-256' })
process.env.CONSOLE_JWT_PRIVATE_KEY = usKey.privateKey.export({ type: 'pkcs8', format: 'pem' })
process.env.CONSOLE_EU_JWT_PRIVATE_KEY = euKey.privateKey.export({ type: 'pkcs8', format: 'pem' })
process.env.AGENTMAIL_MCP_NO_LISTEN = '1'
process.env.AGENTMAIL_API_URL = `http://127.0.0.1:${us.server.address().port}`
process.env.AGENTMAIL_EU_API_URL = `http://127.0.0.1:${eu.server.address().port}/`
const { app, apiEndpointFor, apiKeyRegion, listUserOrgMemberships, resolveClerkConsoleJwt } = await import(
    '../packages/server/build/index.js'
)

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

test('an API key\'s region is its prefix, and the EU override applies to the EU region only', () => {
    assert.equal(apiKeyRegion('am_eu_x'), 'eu')
    assert.equal(apiKeyRegion('am_us_x'), 'us')
    assert.equal(apiEndpointFor('eu').http, process.env.AGENTMAIL_EU_API_URL.replace(/\/$/, ''))
    assert.equal(apiEndpointFor('us').http, process.env.AGENTMAIL_API_URL)
})

/** Whether an ES256 JWT's signature verifies against a public key. */
function signedBy(jwt, publicKey) {
    const [header, payload, signature] = jwt.split('.')
    return verify('sha256', Buffer.from(`${header}.${payload}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'))
}

/** Answer the user's Clerk membership lookup with one organization, through the membership cache. */
async function memberOf(clerkUserId, organization) {
    await listUserOrgMemberships(clerkUserId, { listMemberships: async () => ({ data: [{ organization }] }) })
}

test('an EU organization\'s OAuth calls look it up on, and sign for, the EU API', async () => {
    await memberOf('user_eu', { id: 'org_eu', name: 'EU', publicMetadata: { api_region: 'eu' } })
    const { jwt, region } = await resolveClerkConsoleJwt('user_eu', 'org_eu')
    assert.equal(region, 'eu')
    assert.equal(us.requests.length, 0)
    // The bootstrap lookup reached the EU API, signed with the EU key.
    assert.deepEqual(eu.requests.map((r) => r.url), ['/v0/auth/internal-org'])
    assert.ok(signedBy(eu.requests[0].authorization.slice('Bearer '.length), euKey.publicKey))
    // So is the JWT the tool calls carry, which names the EU organization.
    assert.ok(signedBy(jwt, euKey.publicKey))
    assert.equal(signedBy(jwt, usKey.publicKey), false)
    assert.equal(JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url')).organizationId, 'eu_internal_org')
})

test('a US organization\'s OAuth calls keep the deployment backend and the US key', async () => {
    await memberOf('user_us', { id: 'org_us', name: 'US', publicMetadata: {} })
    const { jwt, region } = await resolveClerkConsoleJwt('user_us', 'org_us')
    assert.equal(region, 'us')
    assert.equal(eu.requests.length, 0)
    assert.deepEqual(us.requests.map((r) => r.url), ['/v0/auth/internal-org'])
    assert.ok(signedBy(jwt, usKey.publicKey))
})

test('an EU organization whose internal id Clerk already holds skips the lookup', async () => {
    await memberOf('user_eu_cached', {
        id: 'org_eu_cached',
        name: 'EU cached',
        publicMetadata: { api_region: 'eu', internalOrgId: 'eu_cached_internal_org' },
    })
    const { jwt, region } = await resolveClerkConsoleJwt('user_eu_cached', 'org_eu_cached')
    assert.equal(region, 'eu')
    assert.equal(us.requests.length + eu.requests.length, 0)
    assert.ok(signedBy(jwt, euKey.publicKey))
})

test('without the EU console key, an EU organization fails naming the missing key', async () => {
    await memberOf('user_eu_nokey', { id: 'org_eu_nokey', name: 'EU', publicMetadata: { api_region: 'eu', internalOrgId: 'x' } })
    const saved = process.env.CONSOLE_EU_JWT_PRIVATE_KEY
    delete process.env.CONSOLE_EU_JWT_PRIVATE_KEY
    try {
        await assert.rejects(resolveClerkConsoleJwt('user_eu_nokey', 'org_eu_nokey'), /CONSOLE_EU_JWT_PRIVATE_KEY/)
    } finally {
        process.env.CONSOLE_EU_JWT_PRIVATE_KEY = saved
    }
})
