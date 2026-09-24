import assert from 'node:assert/strict'
import test from 'node:test'

process.env.AGENTMAIL_MCP_NO_LISTEN = '1'
process.env.BUILD_SHA = 'test-sha'
const { app, mapMcpRequestError } = await import('../packages/server/build/index.js')

test('health identifies the build and human MCP navigation redirects before auth', async (t) => {
  const server = app.listen(0)
  t.after(() => server.close())
  await new Promise((resolve) => server.once('listening', resolve))
  const { port } = server.address()

  const health = await fetch(`http://127.0.0.1:${port}/health`)
  assert.equal(
    health.headers.get('strict-transport-security'),
    'max-age=31536000; includeSubDomains'
  )
  const { heap, requests, sockets, tcp, cpu, ...healthRest } = await health.json()
  assert.deepEqual(healthRest, {
    status: 'ok',
    clerk_enabled: false,
    agentmail_api_url: '(SDK default)',
    mcp_public_url: '(not set, using Host header)',
    build_sha: 'test-sha',
  })
  assert.ok(heap.used_mb > 0)
  assert.ok(heap.limit_mb >= heap.used_mb)
  assert.ok(heap.rss_mb > 0)

  // Concurrency is the failure mode this server actually has, so /health has to
  // report it. /health is not part of the MCP pipeline and must never consume a
  // slot itself, or the probe would distort the number it reports.
  assert.equal(requests.in_flight, 0)
  assert.ok(requests.max_in_flight > 0)
  assert.ok(requests.max_event_loop_lag_ms > 0)
  assert.equal(typeof requests.shed_total, 'number')

  // Socket telemetry is present even when the process is not listening (tests
  // import the app without listening), so counters read zero. open_fds and
  // max_fds come from /proc and are null where it does not exist (macOS).
  assert.equal(typeof sockets.open_connections, 'number')
  assert.equal(typeof sockets.accepted_total, 'number')
  assert.equal(typeof sockets.client_errors_total, 'number')
  assert.ok('open_fds' in sockets)
  assert.ok('max_fds' in sockets)

  // Kernel TCP counters come from /proc and are null where it does not exist
  // (macOS); the shape is always present so dashboards can rely on it.
  for (const k of ['sockstat', 'port', 'tcp', 'tcp_ext', 'kernel', 'connection_header', 'http_version']) {
    assert.ok(k in tcp, `tcp.${k}`)
  }

  // CPU steal comes from /proc/stat deltas computed by the 1 Hz sampler, which
  // only runs when listening; here (and on macOS, where /proc is absent) the
  // values are null but the shape is always present.
  for (const k of ['steal_pct', 'busy_pct', 'idle_pct']) {
    assert.ok(k in cpu, `cpu.${k}`)
  }

  const redirect = await fetch(`http://127.0.0.1:${port}/mcp`, {
    headers: { accept: 'text/html' },
    redirect: 'manual',
  })
  assert.equal(redirect.status, 302)
  assert.equal(redirect.headers.get('location'), 'https://docs.agentmail.to/integrations/mcp')
})

test('stateless server sheds GET SSE and DELETE with 405 before building any per-request state', async (t) => {
  const server = app.listen(0)
  t.after(() => server.close())
  await new Promise((resolve) => server.once('listening', resolve))
  const { port } = server.address()

  // Before this guard, a GET with accept: text/event-stream opened a
  // standalone SSE stream the SDK held open forever, pinning a full
  // McpServer + transport graph per connection — the amplifier behind the
  // Jul 21 reconnect-storm heap exhaustion.
  for (const path of ['/', '/mcp']) {
    for (const method of ['GET', 'DELETE']) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: { accept: 'application/json, text/event-stream' },
      })
      assert.equal(res.status, 405, `${method} ${path}`)
      assert.equal(res.headers.get('allow'), 'POST')
      const body = await res.json()
      assert.equal(body.error.code, -32000)
    }
  }

  // POST still works end to end.
  const ping = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 1 }),
  })
  assert.equal(ping.status, 200)
})

test('malformed unauthenticated JSON gets a sanitized JSON-RPC error for registered MCP route aliases', async (t) => {
  const server = app.listen(0)
  t.after(() => server.close())
  await new Promise((resolve) => server.once('listening', resolve))
  const { port } = server.address()

  for (const path of ['/', '/mcp', '/mcp/', '/MCP', '/MCP/']) {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    })

    assert.equal(res.status, 400)
    assert.match(res.headers.get('content-type') ?? '', /application\/json/)
    assert.equal(
      res.headers.get('strict-transport-security'),
      'max-age=31536000; includeSubDomains'
    )
    assert.deepEqual(await res.json(), {
      jsonrpc: '2.0',
      error: { code: -32700, message: 'Parse error' },
      id: null,
    })
  }
})

test('MCP body-parser client errors retain a safe HTTP status and JSON-RPC response', async (t) => {
  const server = app.listen(0)
  t.after(() => server.close())
  await new Promise((resolve) => server.once('listening', resolve))
  const { port } = server.address()

  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-encoding': 'compress',
    },
    body: '{}',
  })

  assert.equal(res.status, 415)
  assert.match(res.headers.get('content-type') ?? '', /application\/json/)
  assert.deepEqual(await res.json(), {
    jsonrpc: '2.0',
    error: { code: -32600, message: 'Unsupported request encoding' },
    id: null,
  })
})

test('non-MCP route failures never expose diagnostics even in development', async (t) => {
  const server = app.listen(0)
  t.after(() => server.close())
  await new Promise((resolve) => server.once('listening', resolve))
  const { port } = server.address()
  const previousEnv = app.get('env')
  app.set('env', 'development')
  t.after(() => app.set('env', previousEnv))
  const errorLogs = []
  t.mock.method(console, 'error', (...args) => errorLogs.push(args))
  t.mock.method(process, 'memoryUsage', () => {
    throw new Error('private health diagnostic /srv/app/secret.ts:42')
  })

  const res = await fetch(`http://127.0.0.1:${port}/health`)
  assert.equal(res.status, 500)
  assert.match(res.headers.get('content-type') ?? '', /application\/json/)
  assert.deepEqual(await res.json(), { error: 'Internal server error' })
  assert.equal(errorLogs.length, 1)
  assert.equal(errorLogs[0][0], '[http] Request failed, returning sanitized error')
  assert.equal(errorLogs[0][1].status, 500)
  assert.equal(errorLogs[0][1].name, 'Error')
  assert.match(errorLogs[0][1].stackFrames, /server-http\.test\.mjs/)
  assert.equal(JSON.stringify(errorLogs).includes('private health diagnostic'), false)
})

test('non-MCP client errors preserve 4xx status and log only safe metadata', async (t) => {
  const server = app.listen(0)
  t.after(() => server.close())
  await new Promise((resolve) => server.once('listening', resolve))
  const { port } = server.address()
  const errorLogs = []
  const warningLogs = []
  const marker = 'sensitive-request-marker'
  t.mock.method(console, 'error', (...args) => errorLogs.push(args))
  t.mock.method(console, 'warn', (...args) => warningLogs.push(args))
  t.mock.method(process, 'memoryUsage', () => {
    throw Object.assign(new Error(marker), {
      statusCode: 429,
      type: 'client.rate_limited',
      code: 'ERATELIMIT',
      body: marker,
      headers: { authorization: marker },
    })
  })

  const res = await fetch(`http://127.0.0.1:${port}/health`)
  assert.equal(res.status, 429)
  assert.match(res.headers.get('content-type') ?? '', /application\/json/)
  assert.deepEqual(await res.json(), { error: 'Request failed' })
  assert.deepEqual(errorLogs, [])
  assert.deepEqual(warningLogs, [
    [
      '[http] Client request failed, returning sanitized error',
      { status: 429, name: 'Error', type: 'client.rate_limited', code: 'ERATELIMIT' },
    ],
  ])
  assert.equal(JSON.stringify(warningLogs).includes(marker), false)
})

test('unsupported JSON charset returns a sanitized encoding error', async (t) => {
  const server = app.listen(0)
  t.after(() => server.close())
  await new Promise((resolve) => server.once('listening', resolve))
  const { port } = server.address()
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=iso-8859-1' },
    body: '{}',
  })
  assert.equal(res.status, 415)
  assert.deepEqual(await res.json(), {
    jsonrpc: '2.0',
    error: { code: -32600, message: 'Unsupported request encoding' },
    id: null,
  })
})

test('MCP error mapping distinguishes parse failures and preserves other client statuses', () => {
  assert.deepEqual(mapMcpRequestError({ status: 400, type: 'entity.verify.failed' }), {
    status: 400,
    code: -32600,
    message: 'Invalid request',
  })
  assert.deepEqual(mapMcpRequestError({ status: 400, type: 'entity.parse.failed' }), {
    status: 400,
    code: -32700,
    message: 'Parse error',
  })
  assert.deepEqual(mapMcpRequestError({ statusCode: 401 }), {
    status: 401,
    code: -32600,
    message: 'Invalid request',
  })
  assert.deepEqual(mapMcpRequestError({ status: 413, type: 'entity.too.large' }), {
    status: 413,
    code: -32600,
    message: 'Request too large',
  })
})
