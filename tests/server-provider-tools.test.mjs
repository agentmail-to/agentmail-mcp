import assert from 'node:assert/strict'
import test from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

process.env.AGENTMAIL_MCP_NO_LISTEN = '1'
// Pinned before import: provider-tools resolves its API base at module load,
// the same way index.ts resolves AGENTMAIL_API_URL for the SDK client.
process.env.AGENTMAIL_API_URL = 'https://api.example.test'

const { createMcpServer } = await import('../packages/server/build/index.js')

/** Call one tool through a real MCP client against a per-test server, with
 * global fetch stubbed — exercising the registration wrapper in index.ts, not
 * just the tool functions. Teardown runs in finally so a failing assertion or
 * a rejected callTool (e.g. client-side argument validation) cannot leak the
 * server/transport pair or the fetch stub into later tests. */
async function callTool(auth, name, args, fetchStub) {
  const calls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    return fetchStub(url, init)
  }
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const server = createMcpServer(auth)
  const client = new Client({ name: 'provider-tools-test', version: '1.0.0' })
  try {
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    const result = await client.callTool({ name, arguments: args })
    return { result, calls }
  } finally {
    globalThis.fetch = realFetch
    await client.close().catch(() => {})
    await server.close().catch(() => {})
  }
}

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

const apiKeyAuth = { kind: 'apiKey', apiKey: 'am_test_key' }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

const wireEntry = {
  provider_id: '11111111-1111-4111-8111-111111111111',
  client_id: 'client-abc',
  name: 'Example RP',
  updated_at: '2026-08-30T00:00:00.000Z',
  connected: true,
  connectable: false,
  logo_uri: 'https://cdn.example.test/logo.png',
}

const camelEntry = {
  providerId: wireEntry.provider_id,
  clientId: wireEntry.client_id,
  name: wireEntry.name,
  updatedAt: wireEntry.updated_at,
  connected: true,
  connectable: false,
  logoUri: wireEntry.logo_uri,
}

const accepted = {
  enrollment_session_id: '33333333-3333-4333-8333-333333333333',
  magic_url: 'https://id.example.test/connect#token',
  expires_at: '2026-08-31T00:15:00.000Z',
}

test('list_providers maps camelCase args to the wire query and republishes camelCase', async () => {
  const { result, calls } = await callTool(
    apiKeyAuth,
    'list_providers',
    { limit: 25, pageToken: 'tok123', connected: true },
    () => json({ count: 1, limit: 25, next_page_token: 'tok456', truncated: true, providers: [wireEntry] }),
  )

  assert.equal(calls.length, 1)
  const url = new URL(calls[0].url)
  assert.equal(url.origin, 'https://api.example.test')
  assert.equal(url.pathname, '/v0/providers')
  assert.equal(url.searchParams.get('limit'), '25')
  assert.equal(url.searchParams.get('page_token'), 'tok123')
  assert.equal(url.searchParams.get('connected'), 'true')
  assert.equal(calls[0].init.headers.Authorization, 'Bearer am_test_key')

  assert.equal(result.isError, false)
  assert.deepEqual(result.structuredContent, {
    count: 1,
    limit: 25,
    nextPageToken: 'tok456',
    truncated: true,
    providers: [camelEntry],
  })
})

test('search_providers requires q and forwards it', async () => {
  const { result, calls } = await callTool(
    apiKeyAuth,
    'search_providers',
    { q: 'exam' },
    () => json({ count: 1, limit: 50, truncated: false, providers: [wireEntry] }),
  )
  const url = new URL(calls[0].url)
  assert.equal(url.pathname, '/v0/providers/search')
  assert.equal(url.searchParams.get('q'), 'exam')
  assert.equal(result.isError, false)
  assert.deepEqual(result.structuredContent.providers, [camelEntry])
})

test('get_provider surfaces the API error message AND its fix field', async () => {
  const { result, calls } = await callTool(
    apiKeyAuth,
    'get_provider',
    { providerId: wireEntry.provider_id },
    () =>
      json(
        {
          code: 'not_found',
          message: 'Route not found',
          fix: 'Magic browser credential enrollment is not enabled in this environment.',
        },
        404,
      ),
  )
  assert.equal(new URL(calls[0].url).pathname, `/v0/providers/${wireEntry.provider_id}`)
  assert.equal(result.isError, true)
  assert.match(
    result.content[0].text,
    /AgentMail API 404: Route not found — Magic browser credential enrollment is not enabled/,
  )
})

test('a non-UUID providerId is rejected client-side, before any API call', async () => {
  // The SDK validates arguments against the tool's input schema and returns
  // the failure as an in-band isError result naming the bad field.
  const { result, calls } = await callTool(apiKeyAuth, 'get_provider', { providerId: 'client-abc' }, () => {
    throw new Error('must not reach the API')
  })
  assert.equal(calls.length, 0)
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /Invalid UUID/)
})

test('list_provider_connections republishes rows camelCase, withholds pod_id, keeps truncated', async () => {
  const wireConnection = {
    inbox_id: 'agent@example.agentmail.to',
    pod_id: '22222222-2222-4222-8222-222222222222',
    first_signed_up_at: '2026-08-01T00:00:00.000Z',
    last_signed_in_at: '2026-08-30T00:00:00.000Z',
    sign_in_count: 3,
  }
  const { result, calls } = await callTool(
    apiKeyAuth,
    'list_provider_connections',
    { providerId: wireEntry.provider_id },
    () => json({ count: 1, truncated: true, connections: [wireConnection] }),
  )
  assert.equal(new URL(calls[0].url).pathname, `/v0/providers/${wireEntry.provider_id}/connections`)
  assert.equal(result.isError, false)
  assert.deepEqual(result.structuredContent, {
    count: 1,
    truncated: true,
    connections: [
      {
        inboxId: wireConnection.inbox_id,
        firstSignedUpAt: wireConnection.first_signed_up_at,
        lastSignedInAt: wireConnection.last_signed_in_at,
        signInCount: wireConnection.sign_in_count,
      },
    ],
  })
})

test('create_provider_connection sends an Idempotency-Key and the inbox body', async () => {
  const { result, calls } = await callTool(
    apiKeyAuth,
    'create_provider_connection',
    { providerId: wireEntry.provider_id, inboxId: 'agent@example.agentmail.to' },
    () => json(accepted, 202),
  )
  const { init } = calls[0]
  assert.equal(init.method, 'POST')
  // Auto-generated when the caller does not pass one — the API requires it.
  assert.match(init.headers['Idempotency-Key'], UUID_RE)
  assert.deepEqual(JSON.parse(init.body), { inbox_id: 'agent@example.agentmail.to' })
  assert.equal(result.isError, false)
  assert.deepEqual(result.structuredContent, {
    enrollmentSessionId: accepted.enrollment_session_id,
    magicUrl: accepted.magic_url,
    expiresAt: accepted.expires_at,
  })
})

test('auto-generated idempotency keys are fresh per call, never a shared constant', async () => {
  // The API's contract is dedup-with-conflict, not replay: a reused key 409s.
  // A module-level constant key would pass any single-call test while breaking
  // every create after the first in production — so pin per-call freshness.
  const first = await callTool(
    apiKeyAuth,
    'create_provider_connection',
    { providerId: wireEntry.provider_id, inboxId: 'agent@example.agentmail.to' },
    () => json(accepted, 202),
  )
  const second = await callTool(
    apiKeyAuth,
    'create_provider_connection',
    { providerId: wireEntry.provider_id, inboxId: 'agent@example.agentmail.to' },
    () => json(accepted, 202),
  )
  const key1 = first.calls[0].init.headers['Idempotency-Key']
  const key2 = second.calls[0].init.headers['Idempotency-Key']
  assert.match(key1, UUID_RE)
  assert.match(key2, UUID_RE)
  assert.notEqual(key1, key2)
})

test('create_provider_connection omits the body and honors a caller idempotency key', async () => {
  const { calls } = await callTool(
    apiKeyAuth,
    'create_provider_connection',
    { providerId: wireEntry.provider_id, idempotencyKey: 'retry-key-1' },
    () => json(accepted, 202),
  )
  assert.equal(calls[0].init.headers['Idempotency-Key'], 'retry-key-1')
  assert.equal(calls[0].init.body, undefined)
})

test('create_provider_connection refuses OAuth sessions without calling the API', async () => {
  const { result, calls } = await callTool(
    { kind: 'clerk', clerkUserId: 'user_1' },
    'create_provider_connection',
    { providerId: wireEntry.provider_id },
    () => {
      throw new Error('must not reach the API')
    },
  )
  assert.equal(calls.length, 0)
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /requires an API-key session/)
})

test('provider tools without any auth return the standard no-auth error', async () => {
  const { result, calls } = await callTool({ kind: 'none' }, 'list_providers', {}, () => {
    throw new Error('must not reach the API')
  })
  assert.equal(calls.length, 0)
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /Not authenticated/)
})

test('read tools retry transient statuses with real backoff when Retry-After is absent', async () => {
  // Bare 503s, no Retry-After: the common outage shape. The elapsed-time floor
  // pins that the retries actually back off (250ms + 500ms fallback) — a parse
  // bug that reads a missing header as "0ms" would send all three requests
  // back-to-back and fail this assertion.
  let attempts = 0
  const started = Date.now()
  const { result, calls } = await callTool(apiKeyAuth, 'list_providers', {}, () => {
    attempts += 1
    if (attempts < 3) return new Response('busy', { status: 503 })
    return json({ count: 0, providers: [] })
  })
  assert.equal(calls.length, 3)
  assert.equal(result.isError, false)
  assert.ok(Date.now() - started >= 700, 'retries must be spaced by the backoff, not immediate')
})

test('a numeric Retry-After shortens the backoff instead of the fallback', async () => {
  let attempts = 0
  const started = Date.now()
  const { calls } = await callTool(apiKeyAuth, 'list_providers', {}, () => {
    attempts += 1
    if (attempts < 3) return new Response('busy', { status: 503, headers: { 'retry-after': '0' } })
    return json({ count: 0, providers: [] })
  })
  assert.equal(calls.length, 3)
  // Two honored zero-second waits: far under the 750ms the fallback would take.
  assert.ok(Date.now() - started < 700, 'Retry-After: 0 must override the exponential fallback')
})

test('create_provider_connection never retries — a duplicate POST could double-mint', async () => {
  const { result, calls } = await callTool(
    apiKeyAuth,
    'create_provider_connection',
    { providerId: wireEntry.provider_id, inboxId: 'agent@example.agentmail.to' },
    () => new Response('busy', { status: 503, headers: { 'retry-after': '0' } }),
  )
  assert.equal(calls.length, 1)
  assert.equal(result.isError, true)
})

test('a non-JSON 2xx body is reported as an upstream problem, not a parse crash', async () => {
  const { result } = await callTool(
    apiKeyAuth,
    'list_providers',
    {},
    () => new Response('<html>proxy interstitial</html>', { status: 200 }),
  )
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /non-JSON 200 response/)
})

test('a 2xx body missing its envelope array is reported as an unexpected shape', async () => {
  const { result } = await callTool(apiKeyAuth, 'list_providers', {}, () => json({ count: 1 }))
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /unexpected \/v0\/providers response shape/)
})

test('a response that violates the declared output schema is an internal error, not output', async () => {
  const { result } = await callTool(
    apiKeyAuth,
    'list_providers',
    {},
    () => json({ providers: [{ provider_id: 'not-the-right-shape' }] }),
  )
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /did not match its declared output schema/)
})
