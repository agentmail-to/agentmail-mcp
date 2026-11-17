import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync } from 'node:crypto'
import test from 'node:test'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'

process.env.AGENTMAIL_MCP_NO_LISTEN = '1'
process.env.AGENTMAIL_API_URL = 'https://api.example.test'
process.env.POSTHOG_API_KEY = 'phc_test'
process.env.POSTHOG_HOST = 'https://posthog.example.test/'
// As the manifest generator sets them: the Clerk client needs a key before it can be stubbed.
process.env.CLERK_PUBLISHABLE_KEY ||= 'pk_test_contract'
process.env.CLERK_SECRET_KEY ||= 'sk_test_contract'
process.env.CONSOLE_JWT_PRIVATE_KEY = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    .privateKey.export({ type: 'pkcs8', format: 'pem' })
    .toString()

const { authRouter, createMcpServer, getStartedSteps, inGetStartedTest, loadProtocolSnapshot, protocolFastPath, toolsListJsonFor } =
    await import(
    '../packages/server/build/index.js'
)
// The server's own ESM copy of the Clerk client, whose users API is one shared object.
const { clerkClient } = await import(new URL('../packages/server/node_modules/@clerk/express/dist/index.mjs', import.meta.url))

test('the get_started test takes half of users, the same half every time, recomputable from the user ID', () => {
    const ids = Array.from({ length: 10_000 }, (_, i) => `user_${i.toString(36)}`)
    const inTest = ids.filter(inGetStartedTest)
    assert.ok(inTest.length > 4_800 && inTest.length < 5_200, `${inTest.length} of 10,000`)
    assert.deepEqual(ids.filter(inGetStartedTest), inTest)
    // What the analysis runs on creator_user_id in PostHog:
    // reinterpretAsUInt8(substring(MD5(concat('get_started_v1:', id)), 1, 1)) < 128
    const recomputed = (id) => createHash('md5').update(`get_started_v1:${id}`).digest()[0] < 128
    assert.ok(ids.every((id) => recomputed(id) === inGetStartedTest(id)))
})

test('only OAuth users in the test get get_started in tools/list, on the fast path and the full path', async () => {
    const snapshot = await loadProtocolSnapshot()
    const names = (json) => JSON.parse(json).tools.map((tool) => tool.name)
    const others = { kind: 'clerk', clerkUserId: 'user_a', getStarted: false }
    const inTest = { kind: 'clerk', clerkUserId: 'user_b', getStarted: true }

    assert.deepEqual(names(toolsListJsonFor(snapshot, inTest)), [...names(snapshot.toolsListJson), 'get_started'])
    for (const auth of [others, { kind: 'apiKey', apiKey: 'am_test' }, { kind: 'none' }, undefined]) {
        assert.equal(toolsListJsonFor(snapshot, auth), snapshot.toolsListJson)
    }
    assert.ok(!names(snapshot.toolsListJson).includes('get_started'))
})

test('an OAuth request gets its group\'s tools/list through authRouter and the fast path', async () => {
    const snapshot = await loadProtocolSnapshot()
    const ids = Array.from({ length: 50 }, (_, i) => `user_${i}`)
    const listFor = async (userId, scopes) => {
        const req = {
            headers: { authorization: 'Bearer oauth-token', accept: 'application/json' },
            query: {},
            body: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
            auth: () => ({ isAuthenticated: true, tokenType: 'oauth_token', userId, clientId: 'client_1', scopes }),
        }
        let sent
        const res = { status: () => res, set: () => res, send: (text) => (sent = text) }
        await authRouter(req, res, () => {})
        await protocolFastPath(req, res, () => assert.fail('not served by the fast path'))
        return { result: JSON.stringify(JSON.parse(sent).result), authSource: req.authSource }
    }
    const inTest = await listFor(ids.find(inGetStartedTest), ['openid', 'email'])
    assert.equal(inTest.result, snapshot.getStartedToolsListJson)
    assert.equal(inTest.authSource.emailScope, true)
    const others = await listFor(ids.find((id) => !inGetStartedTest(id)), ['openid'])
    assert.equal(others.result, snapshot.toolsListJson)
    assert.equal(others.authSource.emailScope, false)
})

test('get_started steps lead to a first inbox, email, and invitation, each needing the user', () => {
    const [inbox, email, invite] = getStartedSteps('person@example.com', [])
    assert.match(inbox, /create_inbox/)
    assert.match(email, /person@example\.com.*yes.*send_message/)
    assert.match(invite, /person@example\.com.*yes.*create_event.*sendInvites true/)

    assert.match(getStartedSteps('person@example.com', ['agent@agentmail.to'])[0], /^Use agent@agentmail\.to/)
    assert.match(getStartedSteps(undefined, ['agent@agentmail.to'])[1], /ask them for it/)
    // An account with several inboxes is not pointed at one of them.
    assert.match(getStartedSteps(undefined, ['a@agentmail.to', 'b@agentmail.to'])[0], /^The account already has several.*ask the user which/)
})

test('get_started returns the user, the inboxes, and the steps, matching its output schema', async () => {
    const users = clerkClient.users
    const realFetch = globalThis.fetch
    const stubbed = { getUser: users.getUser, getOrganizationMembershipList: users.getOrganizationMembershipList }
    users.getUser = async () => ({ primaryEmailAddress: { emailAddress: 'person@example.com' } })
    users.getOrganizationMembershipList = async () => ({
        data: [{ organization: { id: 'org_1', name: 'Org', publicMetadata: { internalOrgId: 'internal_1' } } }],
    })
    const captured = []
    let inboxesStatus = 200
    globalThis.fetch = async (url, init) => {
        if (String(url) === 'https://posthog.example.test/i/v0/e/') {
            captured.push(JSON.parse(init.body))
            // A failing PostHog must not fail the tool.
            throw new Error('PostHog is down')
        }
        assert.match(String(url), /\/v0\/inboxes\?limit=5$/)
        if (inboxesStatus !== 200) return Response.json({ name: 'ServerError', message: 'down' }, { status: inboxesStatus })
        return Response.json({ count: 1, inboxes: [{ inbox_id: 'agent@agentmail.to', created_at: '2026-10-27T00:00:00Z' }] })
    }
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const auth = {
        kind: 'clerk',
        clerkUserId: 'user_get_started',
        clerkOrgId: 'org_1',
        userAgent: 'Cursor/1.0.0',
        getStarted: true,
        emailScope: true,
    }
    const server = createMcpServer(auth)
    const client = new Client({ name: 'get-started-test', version: '1.0.0' })
    try {
        await server.connect(serverTransport)
        await client.connect(clientTransport)
        await client.listTools()
        const result = await client.callTool({ name: 'get_started', arguments: {} })
        assert.equal(result.isError, undefined, result.content?.[0]?.text)
        assert.deepEqual(result.structuredContent, {
            userEmail: 'person@example.com',
            inboxes: ['agent@agentmail.to'],
            moreInboxes: false,
            steps: getStartedSteps('person@example.com', ['agent@agentmail.to']),
        })

        // Without the address the tool still answers: Clerk failing, or no email scope.
        const withoutEmail = { inboxes: ['agent@agentmail.to'], moreInboxes: false, steps: getStartedSteps(undefined, ['agent@agentmail.to']) }
        users.getUser = async () => {
            throw new Error('Clerk is down')
        }
        assert.deepEqual((await client.callTool({ name: 'get_started', arguments: {} })).structuredContent, withoutEmail)
        users.getUser = async () => assert.fail('looked up the user without the email scope')
        auth.emailScope = false
        assert.deepEqual((await client.callTool({ name: 'get_started', arguments: {} })).structuredContent, withoutEmail)

        // Each call is reported to PostHog under the Clerk user, with no address in it.
        inboxesStatus = 500
        assert.equal((await client.callTool({ name: 'get_started', arguments: {} })).isError, true)
        const event = (properties) => ({
            api_key: 'phc_test',
            event: 'mcp.get_started.called',
            distinct_id: 'user_get_started',
            properties: { ...properties, clerk_organization_id: 'org_1', mcp_user_agent: 'Cursor/1.0.0' },
        })
        const returned = { outcome: 'returned', inbox_count: 1, more_inboxes: false }
        assert.deepEqual(captured, [
            event({ ...returned, has_user_email: true }),
            event({ ...returned, has_user_email: false }),
            event({ ...returned, has_user_email: false }),
            event({ outcome: 'failed' }),
        ])
    } finally {
        Object.assign(users, stubbed)
        globalThis.fetch = realFetch
        await client.close().catch(() => {})
        await server.close().catch(() => {})
    }
})
