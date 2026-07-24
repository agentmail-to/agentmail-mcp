import assert from 'node:assert/strict'
import test from 'node:test'

process.env.AGENTMAIL_MCP_NO_LISTEN = '1'

const { getInternalOrganizationId } = await import('../packages/server/build/index.js')

test('internal organization lookup waits for the Clerk webhook mapping', async () => {
  const statuses = [403, 404, 200]
  const waits = []
  let signCalls = 0
  let fetchCalls = 0

  const result = await getInternalOrganizationId('org_delayed', {
    apiUrl: 'https://api.example.test',
    signToken: async () => {
      signCalls += 1
      return 'bootstrap-token'
    },
    fetcher: async (_url, init) => {
      fetchCalls += 1
      assert.equal(init.headers.Authorization, 'Bearer bootstrap-token')
      const status = statuses.shift()
      return new Response(status === 200 ? JSON.stringify({ organization_id: 'internal_org' }) : '', {
        status,
        headers: { 'content-type': 'application/json' },
      })
    },
    sleep: async (ms) => waits.push(ms),
    retryDelaysMs: [100, 250],
  })

  assert.equal(result, 'internal_org')
  assert.equal(signCalls, 1)
  assert.equal(fetchCalls, 3)
  assert.deepEqual(waits, [100, 250])
})

test('exhausted organization mapping retries return a retryable user-facing error', async () => {
  let fetchCalls = 0
  const waits = []

  await assert.rejects(
    getInternalOrganizationId('org_still_provisioning', {
      apiUrl: 'https://api.example.test',
      signToken: async () => 'bootstrap-token',
      fetcher: async () => {
        fetchCalls += 1
        return new Response('mapping not found', { status: 404 })
      },
      sleep: async (ms) => waits.push(ms),
      retryDelaysMs: [100, 250],
    }),
    /workspace is still provisioning\. Retry this tool in a few seconds\./,
  )

  assert.equal(fetchCalls, 3)
  assert.deepEqual(waits, [100, 250])
})

test('internal organization lookup does not retry unrelated upstream failures', async () => {
  let fetchCalls = 0
  await assert.rejects(
    getInternalOrganizationId('org_broken', {
      apiUrl: 'https://api.example.test',
      signToken: async () => 'bootstrap-token',
      fetcher: async () => {
        fetchCalls += 1
        return new Response('upstream failure', { status: 500 })
      },
      sleep: async () => {
        throw new Error('must not wait')
      },
      retryDelaysMs: [100, 250],
    }),
    /\/v0\/auth\/internal-org failed: 500 upstream failure/,
  )
  assert.equal(fetchCalls, 1)
})
