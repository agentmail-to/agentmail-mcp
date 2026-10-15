import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'

// A stand-in AgentMail API plus S3. upload_file is the first tool whose request
// leaves the AgentMail API: create hands back a presigned URL, the toolkit PUTs
// the bytes there itself, then completes the file through the SDK.
let putStatus = 0 // 0: hold the PUT open and never answer
let putsLive = 0
const requests = []
const upstream = createServer((req, res) => {
    requests.push(`${req.method} ${req.url.split('?')[0]}`)
    if (req.method === 'PUT') {
        // req 'close' fires once the body is read; the response's tracks the connection.
        putsLive++
        res.on('close', () => putsLive--)
        req.resume()
        if (putStatus) req.on('end', () => res.writeHead(putStatus).end())
        return
    }
    req.resume()
    req.on('end', () => {
        const now = new Date().toISOString()
        const file = {
            file_id: 'file_1',
            inbox_id: 'inbox@agentmail.to',
            email: 'inbox@agentmail.to',
            path: 'notes.txt',
            name: 'notes.txt',
            size: 5,
            content_type: 'text/plain; charset=utf-8',
            sha256: 'LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ=',
            created_at: now,
            updated_at: now,
        }
        const { port } = upstream.address()
        const body = req.url.endsWith('/complete')
            ? { ...file, status: 'ready' }
            : { ...file, status: 'pending', upload: { method: 'PUT', url: `http://127.0.0.1:${port}/s3/file_1`, headers: {}, expires_at: now } }
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body))
    })
})
await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
upstream.unref()

process.env.AGENTMAIL_MCP_NO_LISTEN = '1'
process.env.AGENTMAIL_API_URL = `http://127.0.0.1:${upstream.address().port}`
const { app } = await import('../packages/server/build/index.js')

async function withServer(t, fn) {
    requests.length = 0
    const server = app.listen(0)
    t.after(() => {
        server.close()
        upstream.closeAllConnections()
    })
    await new Promise((resolve) => server.once('listening', resolve))
    return fn(server.address().port)
}

const health = async (port) => (await fetch(`http://127.0.0.1:${port}/health`)).json()

const uploadFile = (port, signal) =>
    fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        signal,
        headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            'x-api-key': 'am_dummy',
        },
        body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'upload_file', arguments: { inboxId: 'inbox@agentmail.to', path: 'notes.txt', content: 'hello' } },
        }),
    })

test('a client abort cancels the presigned PUT too', async (t) => {
    putStatus = 0
    await withServer(t, async (port) => {
        const controller = new AbortController()
        const call = uploadFile(port, controller.signal).then((res) => res.text()).catch(() => {})

        await new Promise((resolve) => setTimeout(resolve, 400))
        assert.equal(putsLive, 1, 'PUT is open')

        controller.abort()
        await call
        await new Promise((resolve) => setTimeout(resolve, 300))

        // The PUT is the toolkit's own fetch, not the SDK's, so the signal bound
        // into the client never reaches it; only invoke()'s signal does.
        assert.equal(putsLive, 0, 'PUT was actually cancelled')
        assert.equal((await health(port)).requests.in_flight, 0, 'slot returned')
        assert.ok(!requests.some((request) => request.endsWith('/complete')), 'an abandoned upload is not completed')
    })
})

test('a 412 from the PUT means the bytes already landed, so the file is completed', async (t) => {
    putStatus = 412
    await withServer(t, async (port) => {
        const body = await (await uploadFile(port)).text()

        assert.match(body, /"status\\?":\\?"ready/)
        assert.doesNotMatch(body, /"isError":true/)
        assert.deepEqual(requests, [
            'POST /v0/inboxes/inbox%40agentmail.to/files',
            'PUT /s3/file_1',
            'POST /v0/inboxes/inbox%40agentmail.to/files/file_1/complete',
        ])
    })
})
