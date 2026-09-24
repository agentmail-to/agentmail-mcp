import assert from 'node:assert/strict'
import test from 'node:test'

process.env.AGENTMAIL_MCP_NO_LISTEN = '1'
// Well-formed (but fake) Clerk keys so CLERK_ENABLED is true and the OAuth
// discovery routes are mounted. The metadata handlers compose their response
// from the publishable key and the request URL alone — no Clerk network call.
process.env.CLERK_PUBLISHABLE_KEY = `pk_test_${Buffer.from('example.clerk.accounts.dev$').toString('base64')}`
process.env.CLERK_SECRET_KEY = 'sk_test_oauth_metadata'
const { app } = await import('../packages/server/build/index.js')

// The exact list MCP SDK clients copy into their DCR registration request and
// then request at authorization. Order matters only for readability, but the
// set must not drift: every scope here has to be one Clerk grants to
// dynamically registered clients, or every DCR client fails with
// invalid_scope at consent (2026-05-08 → 2026-06-18).
const ADVERTISED_SCOPES = ['openid', 'email', 'profile', 'user:org:read']

test('protected resource metadata advertises the org scope on both discovery paths', async (t) => {
  const server = app.listen(0)
  t.after(() => server.close())
  await new Promise((resolve) => server.once('listening', resolve))
  const { port } = server.address()

  for (const path of ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource']) {
    const res = await fetch(`http://127.0.0.1:${port}${path}`)
    assert.equal(res.status, 200, `expected 200 for ${path}`)
    const body = await res.json()
    assert.deepEqual(body.scopes_supported, ADVERTISED_SCOPES, `scopes_supported drifted on ${path}`)
  }
})
