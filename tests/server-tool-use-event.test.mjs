import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import test from 'node:test'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'

process.env.AGENTMAIL_MCP_NO_LISTEN = '1'
process.env.AGENTMAIL_API_URL = 'https://api.example.test'
process.env.POSTHOG_API_KEY = 'phc_test'
process.env.POSTHOG_HOST = 'https://posthog.example.test'
process.env.CLERK_PUBLISHABLE_KEY ||= 'pk_test_contract'
process.env.CLERK_SECRET_KEY ||= 'sk_test_contract'
process.env.CONSOLE_JWT_PRIVATE_KEY = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    .privateKey.export({ type: 'pkcs8', format: 'pem' })
    .toString()

const { createMcpServer } = await import('../packages/server/build/index.js')
const { clerkClient } = await import(new URL('../packages/server/node_modules/@clerk/express/dist/index.mjs', import.meta.url))

test('an OAuth user\'s tool calls are reported once a day per tool, and API-key calls are not', async () => {
    const users = clerkClient.users
    const realFetch = globalThis.fetch
    const realMemberships = users.getOrganizationMembershipList
    const realUser = users.getUser
    const organization = (n) => ({ organization: { id: `org_${n}`, name: `Org ${n}`, publicMetadata: { internalOrgId: `internal_${n}` } } })
    // user_tool_use has one organization; user_two_orgs has two and a stored choice between them.
    let chosen = 'org_1'
    users.getOrganizationMembershipList = async ({ userId }) => ({
        data: userId === 'user_two_orgs' ? [organization(1), organization(2)] : [organization(1)],
    })
    users.getUser = async () => ({ privateMetadata: { mcpSelectedOrgId: chosen } })
    const captured = []
    let posthogStatus = 200
    globalThis.fetch = async (url, init) => {
        if (String(url) === 'https://posthog.example.test/i/v0/e/') {
            captured.push(JSON.parse(init.body))
            return new Response(null, { status: posthogStatus })
        }
        return Response.json({ count: 0, inboxes: [] })
    }
    const call = async (auth, names) => {
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
        const server = createMcpServer(auth)
        const client = new Client({ name: 'tool-use-test', version: '1.0.0' })
        try {
            await server.connect(serverTransport)
            await client.connect(clientTransport)
            for (const name of names) {
                const result = await client.callTool({ name, arguments: name === 'search_inboxes' ? { q: 'agent' } : {} })
                assert.ok(!result.isError, result.content?.[0]?.text)
            }
        } finally {
            await client.close().catch(() => {})
            await server.close().catch(() => {})
        }
    }
    try {
        const user = { kind: 'clerk', clerkUserId: 'user_tool_use', clerkOrgId: 'org_1', userAgent: 'Cursor/1.0.0' }
        await call(user, ['list_inboxes', 'list_inboxes', 'search_inboxes'])
        // A second connection the same day adds nothing.
        await call(user, ['list_inboxes'])
        await call({ kind: 'apiKey', apiKey: 'am_test' }, ['list_inboxes'])

        const event = (tool, distinctId = 'user_tool_use', n = 1) => ({
            api_key: 'phc_test',
            event: 'mcp.tool.used',
            distinct_id: distinctId,
            properties: { tool, organization_id: `internal_${n}`, clerk_organization_id: `org_${n}`, mcp_user_agent: 'Cursor/1.0.0' },
        })
        assert.deepEqual(captured, [event('list_inboxes'), event('search_inboxes')])

        // A token that names no organization reports the one each call was routed to.
        captured.length = 0
        const twoOrgs = { kind: 'clerk', clerkUserId: 'user_two_orgs', userAgent: 'Cursor/1.0.0' }
        await call(twoOrgs, ['list_inboxes'])
        chosen = 'org_2'
        await call(twoOrgs, ['list_inboxes', 'list_inboxes'])
        assert.deepEqual(captured, [event('list_inboxes', 'user_two_orgs', 1), event('list_inboxes', 'user_two_orgs', 2)])

        // An event PostHog did not take is sent again on the next call.
        captured.length = 0
        posthogStatus = 503
        await call(twoOrgs, ['search_inboxes'])
        await new Promise((resolve) => setImmediate(resolve))
        posthogStatus = 200
        await call(twoOrgs, ['search_inboxes', 'search_inboxes'])
        assert.deepEqual(captured, [event('search_inboxes', 'user_two_orgs', 2), event('search_inboxes', 'user_two_orgs', 2)])
    } finally {
        users.getOrganizationMembershipList = realMemberships
        users.getUser = realUser
        globalThis.fetch = realFetch
    }
})
