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
  assert.deepEqual(await health.json(), {
    status: 'ok',
    clerk_enabled: false,
    agentmail_api_url: '(SDK default)',
    mcp_public_url: '(not set, using Host header)',
    build_sha: 'test-sha',
  })

  const redirect = await fetch(`http://127.0.0.1:${port}/mcp`, {
    headers: { accept: 'text/html' },
    redirect: 'manual',
  })
  assert.equal(redirect.status, 302)
  assert.equal(redirect.headers.get('location'), 'https://docs.agentmail.to/integrations/mcp')
})
