import assert from 'node:assert/strict'
import test from 'node:test'
import { generateKeyPairSync } from 'node:crypto'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'

// The API's audit log records the user who authorized an OAuth client as the actor of each MCP tool
// call, from the console JWT the call signs: `user_id` is the user the Clerk access token names, and
// `user_email` comes from the public user data Clerk returns with their memberships. Clerk's Backend
// API and the AgentMail API are stand-ins behind one fetch stub, installed before the server loads
// because the Clerk SDK binds fetch when it is imported.

const CLERK_API = 'https://api.clerk.com'
const AGENTMAIL_API = 'https://api.example.test'
const identifiers = new Map() // Clerk user id → the identifier Clerk returns in their public user data
const bearers = [] // the Authorization header of every AgentMail API request

const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

const membership = (userId) => ({
    object: 'organization_membership',
    id: `orgmem_${userId}`,
    role: 'org:admin',
    permissions: [],
    public_metadata: {},
    private_metadata: {},
    created_at: 0,
    updated_at: 0,
    organization: {
        object: 'organization',
        id: 'org_acme',
        name: 'Acme',
        slug: 'acme',
        public_metadata: { internalOrgId: 'internal_org' },
        private_metadata: {},
        created_at: 0,
        updated_at: 0,
    },
    public_user_data: {
        user_id: userId,
        identifier: identifiers.get(userId),
        first_name: null,
        last_name: null,
        image_url: '',
        has_image: false,
    },
})

globalThis.fetch = async (input, init) => {
    const url = new URL(String(input))
    if (url.origin === CLERK_API) {
        const userId = /^\/v1\/users\/([^/]+)\/organization_memberships$/.exec(url.pathname)?.[1]
        if (userId) return json({ data: [membership(userId)], total_count: 1 })
        if (url.pathname === '/v1/oauth_applications') {
            const clientId = url.searchParams.get('name_query')
            return json({ data: [{ object: 'oauth_application', id: 'oa_1', client_id: clientId, name: 'Cursor' }], total_count: 1 })
        }
    }
    if (url.origin === AGENTMAIL_API) {
        bearers.push(new Headers(init?.headers).get('authorization'))
        return json({ count: 0, inboxes: [] })
    }
    throw new Error(`unexpected request ${url}`)
}

const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
process.env.CONSOLE_JWT_PRIVATE_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' })
process.env.CLERK_SECRET_KEY = 'sk_test_console_jwt_user'
process.env.AGENTMAIL_MCP_NO_LISTEN = '1'
process.env.AGENTMAIL_API_URL = AGENTMAIL_API
const { createMcpServer, userEmailFromMemberships } = await import('../packages/server/build/index.js')

/** One list_inboxes call as an OAuth user, through a real MCP client; returns its console JWT's claims. */
async function consoleJwtClaims(clerkUserId) {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const server = createMcpServer({ kind: 'clerk', clerkUserId, clerkClientId: 'Y0enFZG3FF8IFxZr' })
    const client = new Client({ name: 'console-jwt-user-test', version: '1.0.0' })
    try {
        await server.connect(serverTransport)
        await client.connect(clientTransport)
        const sent = bearers.length
        const result = await client.callTool({ name: 'list_inboxes', arguments: {} })
        assert.notEqual(result.isError, true, JSON.stringify(result))
        assert.equal(bearers.length, sent + 1)
        const jwt = bearers.at(-1).replace(/^Bearer /, '')
        return JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString())
    } finally {
        await client.close().catch(() => {})
        await server.close().catch(() => {})
    }
}

test('a tool call’s console JWT names the user the access token was issued to, and their email', async () => {
    identifiers.set('user_2ada', 'ada@example.com')
    identifiers.set('user_2bob', 'bob@example.com')

    const ada = await consoleJwtClaims('user_2ada')
    assert.equal(ada.sub, 'internal_org')
    assert.equal(ada.organizationId, 'internal_org')
    assert.equal(ada.mcp_client_id, 'Y0enFZG3FF8IFxZr')
    assert.equal(ada.user_id, 'user_2ada')
    assert.equal(ada.user_email, 'ada@example.com')

    // Every call signs its own JWT for its own user, including the one served from the membership cache.
    const bob = await consoleJwtClaims('user_2bob')
    assert.deepEqual([bob.user_id, bob.user_email], ['user_2bob', 'bob@example.com'])
    const adaAgain = await consoleJwtClaims('user_2ada')
    assert.deepEqual([adaAgain.user_id, adaAgain.user_email], ['user_2ada', 'ada@example.com'])
    assert.notEqual(adaAgain.jti, ada.jti)
})

test('a user whose Clerk identifier is not an email is named without one', async () => {
    identifiers.set('user_2phone', '+15555550123')
    const claims = await consoleJwtClaims('user_2phone')
    assert.equal(claims.user_id, 'user_2phone')
    assert.equal('user_email' in claims, false)
})

test('the email comes only from a membership of the same user', () => {
    const member = (userId, identifier) => ({ publicUserData: { userId, identifier } })
    assert.equal(userEmailFromMemberships([member('user_a', 'a@example.com')], 'user_a'), 'a@example.com')
    assert.equal(userEmailFromMemberships([member('user_b', 'b@example.com')], 'user_a'), undefined)
    assert.equal(userEmailFromMemberships([member('user_a', 'ada_lovelace')], 'user_a'), undefined)
    assert.equal(userEmailFromMemberships([member('user_a', null), { publicUserData: null }], 'user_a'), undefined)
    assert.equal(userEmailFromMemberships([], 'user_a'), undefined)
})
