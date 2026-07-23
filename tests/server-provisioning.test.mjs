import assert from 'node:assert/strict'
import test from 'node:test'

process.env.AGENTMAIL_MCP_NO_LISTEN = '1'

const {
  getClerkMembershipsForRequest,
  getInternalOrganizationId,
  getOrProvisionClerkMemberships,
} = await import('../packages/server/build/index.js')

const organization = (id = 'org_existing', name = 'Existing Organization') => ({
  id,
  name,
  publicMetadata: {},
})

const dependencies = (overrides = {}) => ({
  listMemberships: async () => [],
  getUser: async () => ({ firstName: 'Ada' }),
  createOrganization: async ({ name }) => ({
    ...organization('org_created', name),
  }),
  sleep: async () => {},
  graceDelaysMs: [],
  ...overrides,
})

test('existing organization memberships never trigger provisioning', async () => {
  let createCalls = 0
  const existing = [{ organization: organization() }]

  const result = await getOrProvisionClerkMemberships(
    'user_existing',
    dependencies({
      listMemberships: async () => existing,
      createOrganization: async () => {
        createCalls += 1
        return organization('org_unexpected')
      },
    }),
  )

  assert.equal(result, existing)
  assert.equal(createCalls, 0)
})

test('zero-org users get a personal organization with the console naming convention', async () => {
  let createParams
  const result = await getOrProvisionClerkMemberships(
    'user_fresh',
    dependencies({
      getUser: async () => ({ firstName: 'Sanjith' }),
      createOrganization: async (params) => {
        createParams = params
        return organization('org_fresh', params.name)
      },
    }),
  )

  assert.deepEqual(createParams, {
    name: "Sanjith's Organization",
    createdBy: 'user_fresh',
    privateMetadata: { agentmailProvisionedBy: 'mcp' },
  })
  assert.equal(result[0].organization.id, 'org_fresh')
})

test('browser provisioning that finishes during the grace window wins', async () => {
  const appeared = [{ organization: organization('org_browser') }]
  let listCalls = 0
  let createCalls = 0

  const result = await getOrProvisionClerkMemberships(
    'user_browser_race',
    dependencies({
      graceDelaysMs: [10, 20],
      listMemberships: async () => (++listCalls >= 2 ? appeared : []),
      createOrganization: async () => {
        createCalls += 1
        return organization('org_unexpected')
      },
    }),
  )

  assert.equal(result, appeared)
  assert.equal(createCalls, 0)
})

test('concurrent first tool calls single-flight organization creation', async () => {
  let createCalls = 0
  let releaseCreate
  const createGate = new Promise((resolve) => {
    releaseCreate = resolve
  })
  const deps = dependencies({
    createOrganization: async ({ name }) => {
      createCalls += 1
      await createGate
      return organization('org_single_flight', name)
    },
  })

  const calls = Array.from({ length: 5 }, () =>
    getOrProvisionClerkMemberships('user_concurrent', deps),
  )
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(createCalls, 1)
  releaseCreate()

  const results = await Promise.all(calls)
  assert.deepEqual(
    results.map((memberships) => memberships[0].organization.id),
    Array(5).fill('org_single_flight'),
  )
})

test('a membership created by another actor recovers a Clerk create conflict', async () => {
  const appeared = [{ organization: organization('org_other_actor') }]
  let createAttempted = false

  const result = await getOrProvisionClerkMemberships(
    'user_external_race',
    dependencies({
      listMemberships: async () => (createAttempted ? appeared : []),
      createOrganization: async () => {
        createAttempted = true
        throw new Error('organization already created')
      },
    }),
  )

  assert.equal(result, appeared)
})

test('an explicit token org never provisions when its user has zero memberships', async () => {
  let getUserCalls = 0
  let createCalls = 0
  let sleepCalls = 0

  const result = await getClerkMembershipsForRequest(
    'user_stale_token',
    'org_stale',
    dependencies({
      graceDelaysMs: [10, 20],
      getUser: async () => {
        getUserCalls += 1
        return { firstName: 'Ada' }
      },
      createOrganization: async () => {
        createCalls += 1
        return organization('org_unexpected')
      },
      sleep: async () => {
        sleepCalls += 1
      },
    }),
  )

  assert.deepEqual(result, [])
  assert.equal(getUserCalls, 0)
  assert.equal(createCalls, 0)
  assert.equal(sleepCalls, 0)
})

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
