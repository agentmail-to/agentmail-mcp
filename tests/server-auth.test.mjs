import assert from 'node:assert/strict'
import test from 'node:test'

process.env.AGENTMAIL_MCP_NO_LISTEN = '1'
// Well-formed (but fake) Clerk keys so CLERK_ENABLED is true and the OAuth
// auth path — where the 2026-07-19 bare-Bearer crash lived — is mounted.
// The malformed-header guard rejects before any Clerk network call happens.
process.env.CLERK_PUBLISHABLE_KEY = `pk_test_${Buffer.from('example.clerk.accounts.dev$').toString('base64')}`
process.env.CLERK_SECRET_KEY = 'sk_test_auth_guard_regression'
const { app } = await import('../packages/server/build/index.js')

test('malformed Authorization headers get a 401 challenge instead of crashing the process', async (t) => {
  const server = app.listen(0)
  t.after(() => server.close())
  await new Promise((resolve) => server.once('listening', resolve))
  const { port } = server.address()

  // Each of these made @clerk/mcp-tools throw on a detached promise, which
  // exited Node with code 1 (Jul 19 incidents at 10:03/10:13/10:14 UTC).
  for (const authorization of ['Bearer', 'bearer', 'not-a-bearer-header']) {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        authorization,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 1 }),
    })
    assert.equal(res.status, 401, `expected 401 for header ${JSON.stringify(authorization)}`)
    assert.match(
      res.headers.get('www-authenticate') ?? '',
      /^Bearer resource_metadata=.*\/\.well-known\/oauth-protected-resource\/mcp$/,
      'challenge must point clients back into OAuth discovery',
    )
    assert.deepEqual(await res.json(), { error: 'Unauthorized' })
  }

  // The server is still alive and serving after the malformed requests.
  const health = await fetch(`http://127.0.0.1:${port}/health`)
  assert.equal(health.status, 200)
  assert.equal((await health.json()).clerk_enabled, true)
})

test('am_ API keys sent as Bearer tokens still route to the API-key path', async (t) => {
  const server = app.listen(0)
  t.after(() => server.close())
  await new Promise((resolve) => server.once('listening', resolve))
  const { port } = server.address()

  // Sanity check that the guard sits behind extractApiKey: a well-formed
  // am_ Bearer header must not be challenged with a 401.
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer am_test_key',
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 1 }),
  })
  assert.equal(res.status, 200)
})
