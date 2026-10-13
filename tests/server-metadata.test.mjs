import assert from 'node:assert/strict'
import test from 'node:test'

process.env.AGENTMAIL_MCP_NO_LISTEN = '1'
// The deployment's public origin. Icons must be served from it: the spec asks
// consumers to check that icon URLs are on the server's own domain.
process.env.MCP_PUBLIC_URL = 'https://mcp.example.test'

const { app } = await import('../packages/server/build/index.js')

const server = app.listen(0)
await new Promise((resolve) => server.once('listening', resolve))
const base = `http://127.0.0.1:${server.address().port}`
test.after(() => server.close())

const MODERN_META = {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientInfo': { name: 'metadata-test', version: '1' },
    'io.modelcontextprotocol/clientCapabilities': {},
}

const rpc = (method, params, headers = {}) =>
    fetch(`${base}/mcp`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            'x-api-key': 'am_dummy',
            ...headers,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })

/** The JSON-RPC result in a response, whether sent as JSON or as a one-event SSE stream. */
async function resultOf(res) {
    assert.equal(res.status, 200)
    const text = await res.text()
    const payload = (res.headers.get('content-type') ?? '').includes('text/event-stream')
        ? text
              .split('\n')
              .filter((line) => line.startsWith('data:'))
              .at(-1)
              .slice('data:'.length)
        : text
    return JSON.parse(payload).result
}

/**
 * serverInfo as each protocol era delivers it, read off the wire: a 2025-era
 * client gets it in the initialize result, a 2026-07-28 client (Manufact's
 * scanner among them) in the _meta of every response, server/discover included.
 */
async function serverInfoByEra() {
    const initialize = await resultOf(
        await rpc('initialize', {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'metadata-test', version: '1' },
        })
    )
    const discover = await resultOf(
        await rpc(
            'server/discover',
            { _meta: MODERN_META },
            { 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'server/discover' }
        )
    )
    return { legacy: initialize.serverInfo, modern: discover._meta['io.modelcontextprotocol/serverInfo'] }
}

test('both protocol eras advertise the same identity, with a title, description and website', async () => {
    const { legacy, modern } = await serverInfoByEra()
    assert.deepEqual(modern, legacy)
    assert.equal(legacy.name, 'AgentMail', 'the stable name clients and directories key on')
    assert.equal(typeof legacy.title, 'string')
    assert.ok(legacy.title.length > 0)
    assert.match(legacy.description ?? '', /email/i)
    assert.equal(new URL(legacy.websiteUrl).protocol, 'https:')
})

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

test('the advertised icons are a vector and a raster of at least 128px, served by this server', async () => {
    const { icons } = (await serverInfoByEra()).legacy
    assert.ok(Array.isArray(icons), 'serverInfo.icons is advertised')
    assert.deepEqual(icons.find((icon) => icon.mimeType === 'image/svg+xml')?.sizes, ['any'])
    assert.ok(icons.some((icon) => icon.mimeType === 'image/png'))

    for (const icon of icons) {
        const src = new URL(icon.src)
        assert.equal(src.origin, 'https://mcp.example.test', `${icon.src} is on the server's own origin`)
        // Fetched anonymously, as clients and directories fetch icons.
        const res = await fetch(`${base}${src.pathname}`)
        assert.equal(res.status, 200, `${src.pathname} is served`)
        assert.equal(res.headers.get('content-type')?.split(';')[0], icon.mimeType)
        const body = Buffer.from(await res.arrayBuffer())
        if (icon.mimeType === 'image/png') {
            assert.deepEqual(body.subarray(0, 8), PNG_SIGNATURE)
            // IHDR, the first chunk: width and height as big-endian u32 at bytes 16 and 20.
            const [width, height] = [body.readUInt32BE(16), body.readUInt32BE(20)]
            assert.deepEqual(icon.sizes, [`${width}x${height}`], 'the advertised size is the real size')
            assert.ok(width >= 128 && height >= 128, `${width}x${height} is at least 128px`)
        } else {
            assert.match(body.toString('utf8'), /^<svg\b[^>]*\bviewBox="/)
        }
    }
})
