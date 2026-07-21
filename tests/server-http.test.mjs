import assert from 'node:assert/strict'
import test from 'node:test'

process.env.AGENTMAIL_MCP_NO_LISTEN = '1'
process.env.BUILD_SHA = 'test-sha'
const { app } = await import('../packages/server/build/index.js')

test('health identifies the build and human MCP navigation redirects before auth', async (t) => {
  const server = app.listen(0)
  t.after(() => server.close())
  await new Promise((resolve) => server.once('listening', resolve))
  const { port } = server.address()

  const health = await fetch(`http://127.0.0.1:${port}/health`)
  const { heap, ...healthRest } = await health.json()
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
