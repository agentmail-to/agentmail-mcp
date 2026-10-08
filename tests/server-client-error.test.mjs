import assert from 'node:assert/strict'
import test from 'node:test'
import { once } from 'node:events'
import http from 'node:http'
import net from 'node:net'

process.env.AGENTMAIL_MCP_NO_LISTEN = '1'
const { startListening } = await import('../packages/server/build/index.js')

async function withListener(t) {
    const server = startListening(0)
    t.after(() => new Promise((resolve) => server.close(resolve)))
    await once(server, 'listening')
    return server.address().port
}

const health = async (port) => (await fetch(`http://127.0.0.1:${port}/health`)).json()

/** Open a raw TCP connection, write bytes, and collect everything until close. */
function rawExchange(port, payload, { timeoutMs = 3000 } = {}) {
    return new Promise((resolve, reject) => {
        const socket = net.connect(port, '127.0.0.1')
        let received = ''
        let closed = false
        const timer = setTimeout(() => {
            if (closed) return
            socket.destroy()
            reject(new Error(`socket still open after ${timeoutMs} ms; received ${JSON.stringify(received)}`))
        }, timeoutMs)
        socket.on('connect', () => socket.write(payload))
        socket.on('data', (chunk) => {
            received += chunk
        })
        socket.on('error', () => {
            /* a reset after the 400 is still a close */
        })
        socket.on('close', () => {
            closed = true
            clearTimeout(timer)
            resolve(received)
        })
    })
}

test('a malformed request gets a 400 and its socket is closed, like Node without a listener', async (t) => {
    const port = await withListener(t)
    const before = (await health(port)).sockets.client_errors_total

    // Registering any 'clientError' listener silences Node's default handling
    // (write a 400, destroy the socket). Counting alone therefore leaked every
    // socket that ever sent unparseable bytes, and the test's timeout is what
    // detects that leak: without the close, rawExchange never resolves.
    const received = await rawExchange(port, 'GARBAGE\r\n\r\n')
    assert.match(received, /^HTTP\/1\.1 400 Bad Request\r\n/)
    assert.match(received, /Connection: close/)

    const after = (await health(port)).sockets.client_errors_total
    assert.equal(after, before + 1, 'the error is still counted')
})

test('oversized headers get a 431, mirroring the status Node would send', async (t) => {
    const port = await withListener(t)
    // Node's default max header size is 16 KiB; one header well past it.
    const payload = `GET /health HTTP/1.1\r\nHost: x\r\nX-Big: ${'a'.repeat(40_000)}\r\n\r\n`
    const received = await rawExchange(port, payload)
    assert.match(received, /^HTTP\/1\.1 431 /)
})

test('request header telemetry is bucketed, so a client cannot grow it without bound', async (t) => {
    const port = await withListener(t)
    // fetch() silently drops a caller-supplied Connection header, so use the
    // plain http client, which sends the value verbatim.
    const send = (connection) =>
        new Promise((resolve, reject) => {
            const req = http.request(
                { host: '127.0.0.1', port, path: '/health', agent: false, headers: { connection } },
                (res) => {
                    res.resume()
                    res.on('end', resolve)
                }
            )
            req.on('error', reject)
            req.end()
        })

    // Connection is client-controlled. Before bucketing, each distinct value
    // became a new key in a process-lifetime map that /health echoed back.
    await send('close')
    await send('keep-alive')
    for (let i = 0; i < 3; i++) await send(`junk-${i}-${Math.random()}`)

    const { tcp } = await health(port)
    const allowedConnection = new Set(['keep-alive', 'close', 'upgrade', '(none)', 'other'])
    for (const key of Object.keys(tcp.connection_header)) {
        assert.ok(allowedConnection.has(key), `unexpected connection bucket ${JSON.stringify(key)}`)
    }
    assert.ok(tcp.connection_header.other >= 3, 'unknown values collapse into one bucket')

    const allowedVersion = new Set(['1.0', '1.1', '2.0', 'other'])
    for (const key of Object.keys(tcp.http_version)) {
        assert.ok(allowedVersion.has(key), `unexpected http version bucket ${JSON.stringify(key)}`)
    }
})
