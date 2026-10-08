import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

process.env.AGENTMAIL_MCP_NO_LISTEN = '1'

const { listUserOrgMemberships, ORG_MEMBERSHIP_PAGE_SIZE } =
  await import('../packages/server/build/index.js')

// Clerk's list endpoints default to 10 rows per page. A user in 11 orgs who
// picked the 11th on the consent screen must still validate (path 1), and the
// org-selection tools must still be able to list and select it.
test('membership lookups fetch past the default page of 10', async () => {
  const memberships = Array.from({ length: 11 }, (_, i) => ({
    organization: { id: `org_${i}`, name: `Org ${i}` },
  }))
  const calls = []

  const result = await listUserOrgMemberships('user_in_eleven_orgs', {
    listMemberships: async (params) => {
      calls.push(params)
      // Behave like Clerk: no limit means the default page of 10.
      return { data: memberships.slice(0, params.limit ?? 10), totalCount: memberships.length }
    },
    cache: new Map(),
  })

  assert.equal(ORG_MEMBERSHIP_PAGE_SIZE, 500, 'the Backend API per-page maximum')
  assert.deepEqual(calls, [{ userId: 'user_in_eleven_orgs', limit: ORG_MEMBERSHIP_PAGE_SIZE }])
  assert.equal(result.length, 11)
  assert.equal(result.at(-1).organization.id, 'org_10')
})

test('every membership lookup goes through the paginated helper', async () => {
  // The original bug was three separate call sites that each omitted `limit`.
  // Keep the raw Clerk call in exactly one place.
  const source = await readFile(new URL('../packages/server/src/index.ts', import.meta.url), 'utf8')
  const rawCalls = source.match(/\.getOrganizationMembershipList\(/g) ?? []
  assert.equal(
    rawCalls.length,
    1,
    'call getOrganizationMembershipList only inside listUserOrgMemberships',
  )
})
