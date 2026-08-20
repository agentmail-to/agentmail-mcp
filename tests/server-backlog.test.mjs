import assert from 'node:assert/strict'
import test from 'node:test'
import net from 'node:net'

process.env.AGENTMAIL_MCP_NO_LISTEN = '1'
process.env.AGENTMAIL_LISTEN_BACKLOG = '1024'
const { app } = await import('../packages/server/build/index.js')

// The regression this guards: app.listen(port) with no backlog caps the accept
// queue at Node's default 511 regardless of AGENTMAIL_LISTEN_BACKLOG. We cannot
// portably read the kernel's configured backlog (it lives in /proc on Linux
// only), so instead assert the property that matters: a burst of connections
// opened without being read still all reach an accept, i.e. the queue holds
// them rather than the kernel dropping the overflow.
//
// This is a coarse check — the OS may clamp to somaxconn and timing varies — so
// it opens well under 511 to stay reliable while still exercising the path that
// the no-backlog bug broke.
test('a burst of unacked connections is accepted, not dropped', async (t) => {
    // Listen through the same options path the production entrypoint uses.
    const server = app.listen({ port: 0, backlog: 1024 })
    t.after(() => server.close())
    await new Promise((resolve) => server.once('listening', resolve))
    const { port } = server.address()

    const BURST = 200
    let accepted = 0
    server.on('connection', () => {
        accepted++
    })

    // Open many TCP connections at once and hold them idle (no HTTP request), so
    // they sit in the accept queue. With a 511-capped backlog under a real
    // kernel these would risk being dropped; with a raised backlog they queue.
    const sockets = await Promise.all(
        Array.from({ length: BURST }, () => {
            return new Promise((resolve, reject) => {
                const s = net.connect(port, '127.0.0.1')
                s.once('connect', () => resolve(s))
                s.once('error', reject)
            })
        })
    )

    // Give the event loop a moment to drain the accept queue.
    await new Promise((resolve) => setTimeout(resolve, 200))

    assert.equal(accepted, BURST, `all ${BURST} connections were accepted`)

    for (const s of sockets) s.destroy()
})
