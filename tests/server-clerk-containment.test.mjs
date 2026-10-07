import assert from 'node:assert/strict'
import test from 'node:test'

process.env.AGENTMAIL_MCP_NO_LISTEN = '1'
// Floored at 500 ms by the implementation, so this is the fastest a timeout
// test can run.
process.env.AGENTMAIL_CLERK_TIMEOUT_MS = '500'
process.env.AGENTMAIL_MAX_CLERK_IN_FLIGHT = '2'

const { boundedClerkCall, ClerkUnavailableError, listUserOrgMemberships, clerkOAuthPreflight, clerkStats } =
    await import('../packages/server/build/index.js')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** A Clerk call the test answers by hand, so no test leaves a call in flight for the next one. */
function stalledCall() {
    let release
    const promise = new Promise((resolve) => {
        release = resolve
    })
    return { run: () => promise, release }
}

test('a Clerk call that does not answer is abandoned at the timeout instead of holding the request', async (t) => {
    const stalled = stalledCall()
    t.after(() => stalled.release('late'))
    const started = Date.now()
    await assert.rejects(boundedClerkCall('membership lookup', stalled.run), (err) => {
        assert.ok(err instanceof ClerkUnavailableError)
        assert.match(err.message, /membership lookup did not answer within 500 ms/)
        return true
    })
    // Well under the 30 s request timeout that previously bounded this.
    assert.ok(Date.now() - started < 2000)
})

test('a successful call resolves normally and frees its in-flight slot', async () => {
    const before = clerkStats().in_flight
    const value = await boundedClerkCall('getUser', async () => 'ok')
    assert.equal(value, 'ok')
    assert.equal(clerkStats().in_flight, before)
})

test('in-flight Clerk calls are capped, and an abandoned call keeps counting until Clerk actually answers', async (t) => {
    // Two calls that Clerk never answers fill the cap of 2. Both time out for
    // their callers, but the underlying requests are still open at Clerk, so
    // they must keep occupying the cap: that is exactly the stall this protects
    // against, and releasing on timeout would let callers stack unbounded
    // requests behind a cap that reads empty.
    await sleep(10)
    assert.equal(clerkStats().in_flight, 0, 'earlier tests released their calls')
    const stalled = stalledCall()
    const first = boundedClerkCall('stalled-1', stalled.run).catch((err) => err)
    const second = boundedClerkCall('stalled-2', stalled.run).catch((err) => err)
    await sleep(20)
    assert.equal(clerkStats().in_flight, 2)

    // Third call: shed immediately, no waiting for the timeout.
    const started = Date.now()
    await assert.rejects(boundedClerkCall('third', async () => 'never runs'), (err) => {
        assert.ok(err instanceof ClerkUnavailableError)
        assert.match(err.message, /busy/)
        return true
    })
    assert.ok(Date.now() - started < 100, 'shedding is instant')

    assert.ok((await first) instanceof ClerkUnavailableError)
    assert.ok((await second) instanceof ClerkUnavailableError)
    assert.equal(clerkStats().in_flight, 2, 'timed-out calls still count while Clerk has not answered')

    stalled.release('late answer')
    await sleep(10)
    assert.equal(clerkStats().in_flight, 0, 'released once Clerk answers')
    t.diagnostic(`timeouts_total=${clerkStats().timeouts_total} shed_total=${clerkStats().shed_total}`)
})

test('memberships are cached per user for the TTL; empty lists and failures are not cached', async () => {
    const memberships = [{ organization: { id: 'org_1', name: 'One' } }]
    let calls = 0
    let now = 1_000_000
    const deps = {
        listMemberships: async () => {
            calls++
            return { data: memberships }
        },
        now: () => now,
        cache: new Map(),
        ttlMs: 5 * 60_000,
    }

    assert.equal((await listUserOrgMemberships('user_a', deps)).length, 1)
    assert.equal((await listUserOrgMemberships('user_a', deps)).length, 1)
    assert.equal(calls, 1, 'second lookup within the TTL is served from cache')

    await listUserOrgMemberships('user_b', deps)
    assert.equal(calls, 2, 'cache is per user')

    now += 5 * 60_000 + 1
    await listUserOrgMemberships('user_a', deps)
    assert.equal(calls, 3, 'expired entry is refreshed')

    // An empty list is the "no organization yet" error path and may change the
    // moment the Clerk webhook lands; never pin it for five minutes.
    const empty = { ...deps, cache: new Map(), listMemberships: async () => ({ data: [] }) }
    await listUserOrgMemberships('user_c', empty)
    assert.equal(empty.cache.size, 0)

    // A failed lookup must not poison the cache either.
    let fail = true
    const flaky = {
        ...deps,
        cache: new Map(),
        listMemberships: async () => {
            if (fail) throw new Error('clerk 503')
            return { data: memberships }
        },
    }
    await assert.rejects(listUserOrgMemberships('user_d', flaky), /clerk 503/)
    fail = false
    assert.equal((await listUserOrgMemberships('user_d', flaky)).length, 1)
})

test('an unauthenticated OAuth preflight is reported as such so the router can challenge it', () => {
    // clerkMiddleware installs req.auth as a function; an expired or otherwise
    // rejected OAuth token yields isAuthenticated: false WITHOUT throwing. The
    // wrapped library answered that with a bare 401 and no WWW-Authenticate, so
    // clients could not restart OAuth discovery.
    const expired = { auth: () => ({ isAuthenticated: false, tokenType: 'oauth_token', userId: null }) }
    assert.equal(clerkOAuthPreflight(expired), false)

    const valid = { auth: () => ({ isAuthenticated: true, tokenType: 'oauth_token', userId: 'user_1' }) }
    assert.equal(clerkOAuthPreflight(valid), true)

    // No auth object at all (middleware did not run) is treated as not
    // authenticated rather than as a crash.
    assert.equal(clerkOAuthPreflight({}), false)
})
