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
    users.getOrganizationMembershipList = async () => ({
        data: [{ organization: { id: 'org_1', name: 'Org', publicMetadata: { internalOrgId: 'internal_1' } } }],
    })
    const captured = []
    globalThis.fetch = async (url, init) => {
        if (String(url) === 'https://posthog.example.test/i/v0/e/') {
            captured.push(JSON.parse(init.body))
            return new Response(null, { status: 200 })
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

        const event = (tool) => ({
            api_key: 'phc_test',
            event: 'mcp.tool.used',
            distinct_id: 'user_tool_use',
            properties: { tool, clerk_organization_id: 'org_1', mcp_user_agent: 'Cursor/1.0.0' },
        })
        assert.deepEqual(captured, [event('list_inboxes'), event('search_inboxes')])
    } finally {
        users.getOrganizationMembershipList = realMemberships
        globalThis.fetch = realFetch
    }
})
