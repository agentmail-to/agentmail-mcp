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

test('get_thread forwards message pagination and republishes its cursor', async () => {
  const timestamp = '2026-09-10T00:00:00.000Z'
  const { result, calls } = await callTool(
    apiKeyAuth,
    'get_thread',
    { inboxId: 'agent@example.com', threadId: 'thread-1', limit: 25, pageToken: 'older-page' },
    () =>
      json({
        inbox_id: 'agent@example.com',
        thread_id: 'thread-1',
        labels: [],
        timestamp,
        senders: [],
        recipients: [],
        last_message_id: 'message-1',
        message_count: 200,
        size: 1,
        updated_at: timestamp,
        created_at: timestamp,
        messages: [],
        count: 0,
        limit: 25,
        next_page_token: 'next-older-page',
      }),
  )

  const url = new URL(calls[0].url)
  assert.equal(url.pathname, '/v0/inboxes/agent%40example.com/threads/thread-1')
  assert.equal(url.searchParams.get('limit'), '25')
  assert.equal(url.searchParams.get('page_token'), 'older-page')
  assert.equal(result.isError, false)
  assert.equal(result.structuredContent.count, 0)
  assert.equal(result.structuredContent.limit, 25)
  assert.equal(result.structuredContent.nextPageToken, 'next-older-page')
  assert.equal('next_page_token' in result.structuredContent, false)
})

const wireProvider = {
  provider_id: '11111111-1111-4111-8111-111111111111',
  name: 'Example RP',
  updated_at: '2026-08-30T00:00:00.000Z',
  description: 'An example provider',
  logo_url: 'https://cdn.example.test/logo.png',
  terms_url: 'https://example.test/terms',
  privacy_url: 'https://example.test/privacy',
}

const camelProvider = {
  providerId: wireProvider.provider_id,
  name: wireProvider.name,
  updatedAt: wireProvider.updated_at,
  description: wireProvider.description,
  logoUrl: wireProvider.logo_url,
  termsUrl: wireProvider.terms_url,
  privacyUrl: wireProvider.privacy_url,
}

const accepted = {
  session_id: '33333333-3333-4333-8333-333333333333',
  magic_url: 'https://id.example.test/connect#token',
  expires_at: '2026-08-31T00:15:00.000Z',
}

test('list_providers maps camelCase args to the wire query and republishes camelCase', async () => {
  const { result, calls } = await callTool(
    apiKeyAuth,
    'list_providers',
    { limit: 25, pageToken: 'tok123' },
    () => json({ count: 1, limit: 25, next_page_token: 'tok456', providers: [wireProvider] }),
  )

  assert.equal(calls.length, 1)
  const url = new URL(calls[0].url)
  assert.equal(url.origin, 'https://api.example.test')
  assert.equal(url.pathname, '/v0/providers')
  assert.equal(url.searchParams.get('limit'), '25')
  assert.equal(url.searchParams.get('page_token'), 'tok123')
  assert.equal(calls[0].init.headers.Authorization, 'Bearer am_test_key')

  assert.equal(result.isError, false)
  assert.deepEqual(result.structuredContent, {
    count: 1,
    limit: 25,
    nextPageToken: 'tok456',
    providers: [camelProvider],
  })
})

test('search_providers requires q and forwards it', async () => {
  const { result, calls } = await callTool(
    apiKeyAuth,
    'search_providers',
    { q: 'exam' },
    () => json({ count: 1, limit: 50, providers: [wireProvider] }),
  )
  const url = new URL(calls[0].url)
  assert.equal(url.pathname, '/v0/providers/search')
  assert.equal(url.searchParams.get('q'), 'exam')
  assert.equal(result.isError, false)
  assert.deepEqual(result.structuredContent.providers, [camelProvider])
})

test('get_provider republishes a bare identity (no updatedAt) as-is', async () => {
  // An unlisted provider the caller holds an account at resolves as id + name
  // only — the schema must not require the catalog fields.
  const { result, calls } = await callTool(
    apiKeyAuth,
    'get_provider',
    { providerId: wireProvider.provider_id },
    () => json({ provider_id: wireProvider.provider_id, name: 'Unlisted RP' }),
  )
  assert.equal(new URL(calls[0].url).pathname, `/v0/providers/${wireProvider.provider_id}`)
  assert.equal(result.isError, false)
  assert.deepEqual(result.structuredContent, {
    providerId: wireProvider.provider_id,
    name: 'Unlisted RP',
  })
})

test('get_provider surfaces the API error message AND its fix field', async () => {
  const { result } = await callTool(
    apiKeyAuth,
    'get_provider',
    { providerId: wireProvider.provider_id },
    () =>
      json(
        {
          code: 'not_found',
          message: 'Provider not found',
          fix: 'List or search providers to find a valid provider_id.',
        },
        404,
      ),
  )
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /AgentMail API 404: Provider not found — List or search providers/)
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

test('list_provider_accounts republishes rows camelCase and withholds tenancy ids', async () => {
  const wireAccount = {
    account_id: '44444444-4444-4444-8444-444444444444',
    provider_id: wireProvider.provider_id,
    provider_name: 'Example RP',
    inbox_id: 'agent@example.agentmail.to',
    pod_id: '22222222-2222-4222-8222-222222222222',
    organization_id: '55555555-5555-4555-8555-555555555555',
    first_signed_in_at: '2026-08-01T00:00:00.000Z',
    last_signed_in_at: '2026-08-30T00:00:00.000Z',
    sign_in_count: 3,
  }
  const { result, calls } = await callTool(
    apiKeyAuth,
    'list_provider_accounts',
    { providerId: wireProvider.provider_id },
    () => json({ provider: wireProvider, count: 1, accounts: [wireAccount] }),
  )
  assert.equal(new URL(calls[0].url).pathname, `/v0/providers/${wireProvider.provider_id}/accounts`)
  assert.equal(result.isError, false)
  assert.deepEqual(result.structuredContent, {
    provider: camelProvider,
    count: 1,
    accounts: [
      {
        accountId: wireAccount.account_id,
        providerId: wireAccount.provider_id,
        providerName: wireAccount.provider_name,
        inboxId: wireAccount.inbox_id,
        firstSignedInAt: wireAccount.first_signed_in_at,
        lastSignedInAt: wireAccount.last_signed_in_at,
        signInCount: wireAccount.sign_in_count,
      },
    ],
  })
})

test('connect_provider sends an Idempotency-Key and the inbox/authorize body', async () => {
  const { result, calls } = await callTool(
    apiKeyAuth,
    'connect_provider',
    { providerId: wireProvider.provider_id, inboxId: 'agent@example.agentmail.to', authorize: true },
    () => json(accepted, 202),
  )
  const { init } = calls[0]
  assert.equal(init.method, 'POST')
  assert.equal(new URL(calls[0].url).pathname, `/v0/providers/${wireProvider.provider_id}/connect`)
  // Auto-generated when the caller does not pass one — the API requires it.
  assert.match(init.headers['Idempotency-Key'], UUID_RE)
  assert.deepEqual(JSON.parse(init.body), { inbox_id: 'agent@example.agentmail.to', authorize: true })
  assert.equal(result.isError, false)
  assert.deepEqual(result.structuredContent, {
    sessionId: accepted.session_id,
    magicUrl: accepted.magic_url,
    expiresAt: accepted.expires_at,
  })
})

test('auto-generated idempotency keys are fresh per call, never a shared constant', async () => {
  // The API's contract is dedup-with-conflict, not replay: a reused key 409s.
  // A module-level constant key would pass any single-call test while breaking
  // every connect after the first in production — so pin per-call freshness.
  const first = await callTool(
    apiKeyAuth,
    'connect_provider',
    { providerId: wireProvider.provider_id, inboxId: 'agent@example.agentmail.to' },
    () => json(accepted, 202),
  )
  const second = await callTool(
    apiKeyAuth,
    'connect_provider',
    { providerId: wireProvider.provider_id, inboxId: 'agent@example.agentmail.to' },
    () => json(accepted, 202),
  )
  const key1 = first.calls[0].init.headers['Idempotency-Key']
  const key2 = second.calls[0].init.headers['Idempotency-Key']
  assert.match(key1, UUID_RE)
  assert.match(key2, UUID_RE)
  assert.notEqual(key1, key2)
})

test('connect_provider omits the body and honors a caller idempotency key', async () => {
  const { calls } = await callTool(
    apiKeyAuth,
    'connect_provider',
    { providerId: wireProvider.provider_id, idempotencyKey: 'retry-key-1' },
    () => json(accepted, 202),
  )
  assert.equal(calls[0].init.headers['Idempotency-Key'], 'retry-key-1')
  assert.equal(calls[0].init.body, undefined)
})

test('connect_provider attempts OAuth sessions instead of refusing client-side', async () => {
  // The API owns the credential rule for connect (a console-JWT branch exists
  // behind a deployment flag), so the old hard refusal is gone. Without Clerk
  // env vars the bearer resolution itself fails in this test — the invariant
  // pinned is that no 'requires an API-key session' refusal short-circuits the
  // attempt any more.
  const { result } = await callTool(
    { kind: 'clerk', clerkUserId: 'user_1' },
    'connect_provider',
    { providerId: wireProvider.provider_id },
    () => json(accepted, 202),
  )
  assert.equal(result.isError, true)
  assert.doesNotMatch(result.content[0].text, /requires an API-key session/)
})

test('list_provider_accounts treats provider: null as absent, not a crash', async () => {
  // The API always sends the key — null, never absent — for an unknown or
  // unconnected provider; the common miss case must be an empty list.
  const { result } = await callTool(
    apiKeyAuth,
    'list_provider_accounts',
    { providerId: wireProvider.provider_id },
    () => json({ provider: null, count: 0, accounts: [] }),
  )
  assert.equal(result.isError, false)
  assert.deepEqual(result.structuredContent, { count: 0, accounts: [] })
})

test('connect_provider transmits authorize: false rather than dropping it', async () => {
  // Omitting authorize means "keep the first-use disclosure" — not the same
  // request as an explicit false, so the falsy value must survive.
  const { calls } = await callTool(
    apiKeyAuth,
    'connect_provider',
    { providerId: wireProvider.provider_id, inboxId: 'agent@example.agentmail.to', authorize: false },
    () => json(accepted, 202),
  )
  assert.deepEqual(JSON.parse(calls[0].init.body), { inbox_id: 'agent@example.agentmail.to', authorize: false })
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

test('connect_provider never retries — a duplicate POST could double-mint', async () => {
  const { result, calls } = await callTool(
    apiKeyAuth,
    'connect_provider',
    { providerId: wireProvider.provider_id, inboxId: 'agent@example.agentmail.to' },
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
    () => json({ providers: [{ provider_id: 12345 }] }),
  )
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /did not match its declared output schema/)
})
