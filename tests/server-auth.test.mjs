import assert from 'node:assert/strict'
import test from 'node:test'

process.env.AGENTMAIL_MCP_NO_LISTEN = '1'
// Well-formed (but fake) Clerk keys so CLERK_ENABLED is true and the OAuth
// auth path — where the 2026-07-19 bare-Bearer crash lived — is mounted.
// The malformed-header guard rejects before any Clerk network call happens.
process.env.CLERK_PUBLISHABLE_KEY = `pk_test_${Buffer.from('example.clerk.accounts.dev$').toString('base64')}`
process.env.CLERK_SECRET_KEY = 'sk_test_auth_guard_regression'
const { app } = await import('../packages/server/build/index.js')
const { setLogSink } = await import('../packages/server/build/log.js')

test('malformed Authorization headers get a 401 challenge instead of crashing the process', async (t) => {
  const server = app.listen(0)
  t.after(() => server.close())
  await new Promise((resolve) => server.once('listening', resolve))
  const { port } = server.address()

  // Cover both the bare/malformed scheme shapes that reached
  // @clerk/mcp-tools and JWT-shaped input that fails in the earlier global
  // Clerk request middleware.
  for (const authorization of [
    'Bearer',
    'bearer',
    'not-a-bearer-header',
    // A three-segment token gets past the bare-Bearer guard, then fails while
    // the global Clerk middleware decodes its JWT payload. Production returned
    // an HTML 500 for this shape instead of restarting OAuth.
    'Bearer abc.def.ghi',
  ]) {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        authorization,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      // Not `ping`: pings are answered by the fast path before auth runs, so
      // they can no longer carry a malformed header into the guard at all.
      body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
    })
    assert.equal(res.status, 401, `expected 401 for header ${JSON.stringify(authorization)}`)
    assert.match(
      res.headers.get('www-authenticate') ?? '',
      /^Bearer resource_metadata=.*\/\.well-known\/oauth-protected-resource\/mcp$/,
      'challenge must point clients back into OAuth discovery',
    )
    assert.deepEqual(await res.json(), { error: 'Unauthorized' })
  }

  // A ping with the same malformed header is answered by the fast path with
  // 200 — auth never sees it. This is the intended behavior change: the header
  // shapes that once crash-looped production cannot even reach that code via
  // ping anymore.
  const pingRes = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer',
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 1 }),
  })
  assert.equal(pingRes.status, 200)
  assert.deepEqual(await pingRes.json(), { jsonrpc: '2.0', id: 1, result: {} })

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

test('a token Clerk does not accept is counted on /health and logs nothing', async (t) => {
  const server = app.listen(0)
  t.after(() => server.close())
  await new Promise((resolve) => server.once('listening', resolve))
  const { port } = server.address()
  const health = async () => (await (await fetch(`http://127.0.0.1:${port}/health`)).json()).auth
  const before = await health()

  // Not JWT-shaped, so Clerk refuses it locally, without a network call: the
  // shape every long-lived OAuth connection sends once its 24 h token expires.
  const lines = []
  const restore = setLogSink((_level, line) => lines.push(line))
  t.after(restore)
  for (let i = 0; i < 3; i++) {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer expired_opaque_token',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
    })
    assert.equal(res.status, 401)
    assert.match(res.headers.get('www-authenticate') ?? '', /^Bearer resource_metadata=/)
  }
  restore()

  // At most the once-per-process inbound header names, never a line per refusal.
  assert.deepEqual(
    lines.map((line) => JSON.parse(line).event).filter((event) => event !== 'http.inbound_headers'),
    []
  )
  assert.equal((await health()).token_rejected - before.token_rejected, 3)
})
