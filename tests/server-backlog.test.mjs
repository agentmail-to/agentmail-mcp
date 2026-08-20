import assert from 'node:assert/strict'
import test from 'node:test'
import { once } from 'node:events'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'

process.env.AGENTMAIL_MCP_NO_LISTEN = '1'
// A value clearly distinct from Node's 511 default and within a modern kernel's
// somaxconn (4096), so the effective backlog can only equal this if the
// production listen path actually applied it.
const CONFIGURED_BACKLOG = 2048
process.env.AGENTMAIL_LISTEN_BACKLOG = String(CONFIGURED_BACKLOG)
const { startListening } = await import('../packages/server/build/index.js')

function ssAvailable() {
    try {
        execFileSync('ss', ['-V'], { stdio: 'ignore' })
        return true
    } catch {
        return false
    }
}

// The effective backlog only lives in the kernel; reading it needs Linux + ss.
// On other platforms this cannot be verified, so skip rather than pass vacuously.
const canReadBacklog = process.platform === 'linux' && ssAvailable()

test('the production listener boots and serves through the exported startup path', async (t) => {
    const server = startListening(0)
    t.after(() => new Promise((resolve) => server.close(resolve)))
    await once(server, 'listening')
    const { port } = server.address()

    const res = await fetch(`http://127.0.0.1:${port}/health`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.status, 'ok')
})

test(
    "the production listener applies the configured backlog, not Node's default 511",
    { skip: canReadBacklog ? false : 'requires Linux + ss to read the effective backlog' },
    async (t) => {
        // startListening is the SAME function production calls, so this fails if
        // index.ts is reverted to app.listen(PORT): the effective backlog would
        // drop to 511 and the assertion below would catch it.
        const server = startListening(0)
        t.after(() => new Promise((resolve) => server.close(resolve)))
        await once(server, 'listening')
        const { port } = server.address()

        const somaxconn = Number(fs.readFileSync('/proc/sys/net/core/somaxconn', 'utf8').trim())
        // The kernel caps the accept queue at min(backlog, somaxconn).
        const expected = Math.min(CONFIGURED_BACKLOG, somaxconn)

        // Guard the guard: if somaxconn were tiny the effective value could
        // collapse onto 511 and the test would no longer distinguish them.
        assert.notEqual(expected, 511, `somaxconn ${somaxconn} too small to distinguish backlogs`)
        assert.ok(expected > 511, `expected backlog ${expected} must exceed the 511 default to be meaningful`)

        // For a LISTEN socket, ss reports the configured backlog as Send-Q. No
        // ss-side filter (its expression syntax varies by version); list all
        // listening sockets and match the port in JS. The leading colon plus a
        // word boundary avoids matching a port that is a pre/suffix of another.
        const out = execFileSync('ss', ['-Hltn'], { encoding: 'utf8' })
        const portRe = new RegExp(`:${port}\\b`)
        const line = out.split('\n').find((l) => portRe.test(l))
        assert.ok(line, `ss reported no LISTEN socket on port ${port}: ${JSON.stringify(out)}`)

        // "LISTEN  <Recv-Q>  <Send-Q>  <local>  <peer>" — Send-Q is the backlog.
        const m = line.trim().match(/^\S+\s+\d+\s+(\d+)\s/)
        assert.ok(m, `could not parse Send-Q from ss line: ${JSON.stringify(line)}`)
        const effectiveBacklog = Number(m[1])

        assert.equal(
            effectiveBacklog,
            expected,
            `effective backlog is ${effectiveBacklog}; expected ${expected}. ` +
                `A revert to app.listen(PORT) would show 511.`
        )
    }
)
