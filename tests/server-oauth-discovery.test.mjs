import assert from 'node:assert/strict'
import test from 'node:test'

process.env.AGENTMAIL_MCP_NO_LISTEN = '1'
const FAPI_HOST = 'example.clerk.accounts.dev'
process.env.CLERK_PUBLISHABLE_KEY = `pk_test_${Buffer.from(`${FAPI_HOST}$`).toString('base64')}`
process.env.CLERK_SECRET_KEY = 'sk_test_oauth_discovery'
const { app, buildClerkAuthInfo, deriveClerkFapiUrl, protectedResourceMetadataFor, fetchClerkAuthServerMetadata } =
    await import('../packages/server/build/index.js')

// These three pieces used to come from @clerk/mcp-tools. The shapes are pinned
// to what that library produced so clients see no change from owning them.

test('the Clerk frontend API origin is decoded from the publishable key', () => {
    assert.equal(deriveClerkFapiUrl(process.env.CLERK_PUBLISHABLE_KEY), `https://${FAPI_HOST}`)
})

test('protected resource metadata has the @clerk/mcp-tools shape and names the request resource', async (t) => {
    const server = app.listen(0)
    t.after(() => server.close())
    await new Promise((resolve) => server.once('listening', resolve))
    const { port } = server.address()

    const res = await fetch(`http://127.0.0.1:${port}/.well-known/oauth-protected-resource/mcp`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.resource, `http://127.0.0.1:${port}/mcp`)
    assert.deepEqual(body.authorization_servers, [`https://${FAPI_HOST}`])
    assert.equal(body.jwks_uri, `https://${FAPI_HOST}/.well-known/jwks.json`)
    assert.equal(body.token_introspection_endpoint, `https://${FAPI_HOST}/oauth/token`)
    assert.deepEqual(body.key_challenges_supported, [
        { challenge_type: 'urn:ietf:params:oauth:pkce:code_challenge', challenge_algs: ['S256'] },
    ])
    assert.equal(body.service_documentation, 'https://clerk.com/docs')
    assert.deepEqual(body.scopes_supported, ['openid', 'email', 'profile', 'user:org:read'])

    const root = await (await fetch(`http://127.0.0.1:${port}/.well-known/oauth-protected-resource`)).json()
    assert.equal(root.resource, `http://127.0.0.1:${port}/`)

    // Pure function form, for the record.
    const direct = protectedResourceMetadataFor(process.env.CLERK_PUBLISHABLE_KEY, 'https://mcp.agentmail.to/mcp', {
        scopes_supported: ['openid'],
    })
    assert.equal(direct.resource, 'https://mcp.agentmail.to/mcp')
    assert.deepEqual(direct.scopes_supported, ['openid'])
})

test('authorization-server metadata is fetched once per TTL, shared in flight, and served stale on failure', async () => {
    let calls = 0
    let fail = false
    let now = 1_000_000
    const metadata = { issuer: `https://${FAPI_HOST}`, token_endpoint: `https://${FAPI_HOST}/oauth/token` }
    const fetcher = async () => {
        calls++
        if (fail) throw new Error('clerk down')
        return { ok: true, status: 200, json: async () => metadata }
    }
    const deps = { fetcher, now: () => now, cache: { fetchedAt: 0 }, ttlMs: 1000 }
    const key = process.env.CLERK_PUBLISHABLE_KEY

    const [a, b] = await Promise.all([fetchClerkAuthServerMetadata(key, deps), fetchClerkAuthServerMetadata(key, deps)])
    assert.deepEqual(a, metadata)
    assert.deepEqual(b, metadata)
    assert.equal(calls, 1, 'concurrent cold requests share one Clerk fetch')

    assert.deepEqual(await fetchClerkAuthServerMetadata(key, deps), metadata)
    assert.equal(calls, 1, 'within the TTL nothing is fetched')

    now += 1001
    fail = true
    assert.deepEqual(await fetchClerkAuthServerMetadata(key, deps), metadata, 'stale value survives a Clerk failure')
    assert.equal(calls, 2)

    // Cold cache + failure is the only case the client sees an error.
    const cold = { fetcher, now: () => now, cache: { fetchedAt: 0 }, ttlMs: 1000 }
    await assert.rejects(fetchClerkAuthServerMetadata(key, cold), /clerk down/)
})

test('an accepted OAuth token becomes an MCP AuthInfo; anything incomplete is refused', () => {
    const accepted = {
        auth: () => ({ isAuthenticated: true, tokenType: 'oauth_token', userId: 'user_1', clientId: 'c_1', scopes: ['openid'] }),
    }
    assert.deepEqual(buildClerkAuthInfo(accepted, 'tok'), {
        token: 'tok',
        scopes: ['openid'],
        clientId: 'c_1',
        extra: { userId: 'user_1' },
    })
    assert.equal(buildClerkAuthInfo(accepted, undefined), undefined, 'no token')
    const noUser = { auth: () => ({ isAuthenticated: true, tokenType: 'oauth_token', clientId: 'c_1', scopes: [] }) }
    assert.equal(buildClerkAuthInfo(noUser, 'tok'), undefined)
    const session = { auth: () => ({ isAuthenticated: true, tokenType: 'session_token', userId: 'u' }) }
    assert.equal(buildClerkAuthInfo(session, 'tok'), undefined, 'only OAuth tokens')
    assert.equal(buildClerkAuthInfo({}, 'tok'), undefined, 'no middleware ran')
})
