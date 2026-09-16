import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
    CallToolRequestSchema,
    ErrorCode,
    ListToolsRequestSchema,
    McpError,
    ToolListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js'

import {
    addLocalFileAttachmentVariant,
    parseFileRoot,
    parseTools,
    resolveLocalFileAttachments,
    startBridge,
    validateFileRoot,
} from '../build/index.js'

test('parses the compatibility tool filter', () => {
    assert.equal(parseTools([]), undefined)
    assert.deepEqual([...parseTools(['--tools', 'one, two'])], ['one', 'two'])
    assert.throws(() => parseTools(['--tools']), /requires a comma-separated list/)
})

test('requires an explicit, existing local-file root', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'agentmail-mcp-root-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    assert.equal(parseFileRoot([]), undefined)
    assert.equal(parseFileRoot(['--file-root', root]), root)
    assert.throws(() => parseFileRoot(['--file-root']), /requires a directory path/)
    assert.equal(await validateFileRoot(root), await realpath(root))
    await assert.rejects(validateFileRoot('relative/path'), /must be an absolute directory path/)
    await assert.rejects(validateFileRoot(join(root, 'missing')), /must reference an existing directory/)
})

test('adds a local path variant to attachment-capable tools', () => {
    const tool = addLocalFileAttachmentVariant({
        name: 'send_message',
        inputSchema: {
            type: 'object',
            properties: {
                attachments: {
                    type: 'array',
                    items: {
                        anyOf: [
                            {
                                type: 'object',
                                properties: { filename: { type: 'string' }, url: { type: 'string' } },
                                required: ['url'],
                                additionalProperties: false,
                            },
                            {
                                type: 'object',
                                properties: { filename: { type: 'string' }, content: { type: 'string' } },
                                required: ['content'],
                                additionalProperties: false,
                            },
                        ],
                    },
                },
            },
        },
    })

    const variants = tool.inputSchema.properties.attachments.items.anyOf
    assert.equal(variants.length, 3)
    assert.deepEqual(variants[2].required, ['path'])
    assert.deepEqual(Object.keys(variants[2].properties), ['filename', 'path'])
})

test('reads local attachments without putting their bytes in the client tool call', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'agentmail-mcp-bridge-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    const file = join(root, 'report.pdf')
    await writeFile(file, Buffer.from('%PDF-local-test'))

    const resolved = await resolveLocalFileAttachments(
        {
            attachments: [{ path: 'report.pdf', contentType: 'application/pdf' }],
        },
        root,
    )
    assert.deepEqual(resolved.attachments, [
        {
            filename: 'report.pdf',
            contentType: 'application/pdf',
            content: Buffer.from('%PDF-local-test').toString('base64'),
        },
    ])

    await assert.rejects(
        resolveLocalFileAttachments({ attachments: [{ path: '../outside.pdf' }] }, root),
        /is outside --file-root/,
    )

    await assert.rejects(
        resolveLocalFileAttachments({ attachments: [{ path: 'missing.pdf' }] }, root),
        /does not exist or cannot be read/,
    )

    await writeFile(join(root, '.env'), 'SECRET=value')
    await assert.rejects(
        resolveLocalFileAttachments({ attachments: [{ path: '.env' }] }, root),
        /cannot contain hidden files or directories/,
    )

    const hidden = join(root, '.private')
    await mkdir(hidden)
    await writeFile(join(hidden, 'secret.pdf'), '%PDF-secret')
    await symlink(join(hidden, 'secret.pdf'), join(root, 'public-name.pdf'))
    await assert.rejects(
        resolveLocalFileAttachments({ attachments: [{ path: 'public-name.pdf' }] }, root),
        /cannot resolve through hidden files or directories/,
    )

    await writeFile(join(root, 'real-name-v3.pdf'), '%PDF-real')
    await symlink(join(root, 'real-name-v3.pdf'), join(root, 'report-alias.pdf'))
    const aliased = await resolveLocalFileAttachments({ attachments: [{ path: 'report-alias.pdf' }] }, root)
    assert.equal(aliased.attachments[0].filename, 'report-alias.pdf')
})

test('does not open stdio when the hosted connection fails', async () => {
    let localStarted = false
    const remote = {
        start: async () => {
            throw new Error('network failure')
        },
        send: async () => {},
        close: async () => {},
    }
    const local = {
        start: async () => {
            localStarted = true
        },
        send: async () => {},
        close: async () => {},
    }

    await assert.rejects(startBridge(remote, local), /network failure/)
    assert.equal(localStarted, false)
})

test('reports hosted and stdio transport errors to stderr', async (t) => {
    const [remoteServerTransport, bridgeRemoteTransport] = InMemoryTransport.createLinkedPair()
    const [bridgeLocalTransport] = InMemoryTransport.createLinkedPair()
    const remote = new Server({ name: 'remote', version: '1.0.0' }, { capabilities: { tools: {} } })
    await remote.connect(remoteServerTransport)
    await startBridge(bridgeRemoteTransport, bridgeLocalTransport)
    t.after(() => remote.close())

    const messages = []
    const original = console.error
    console.error = (message) => messages.push(message)
    try {
        bridgeRemoteTransport.onerror(new Error('hosted boom'))
        bridgeLocalTransport.onerror(new Error('stdio boom'))
    } finally {
        console.error = original
    }

    assert.deepEqual(messages, [
        'AgentMail MCP: hosted error: hosted boom',
        'AgentMail MCP: stdio error: stdio boom',
    ])
})

test('forwards the remote tool contract, calls, errors, progress, cancellation, and changes', async (t) => {
    const [remoteServerTransport, bridgeRemoteTransport] = InMemoryTransport.createLinkedPair()
    const [bridgeLocalTransport, localClientTransport] = InMemoryTransport.createLinkedPair()
    const remote = new Server({ name: 'remote', version: '1.0.0' }, { capabilities: { tools: { listChanged: true } } })
    let description = 'remote v1'
    let cancelled = false
    let hiddenCalls = 0
    let markSlowStarted
    const slowStarted = new Promise((resolve) => (markSlowStarted = resolve))

    remote.setRequestHandler(ListToolsRequestSchema, () => ({
        tools: [
            {
                name: 'echo',
                description,
                inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
                outputSchema: { type: 'object', properties: { value: { type: 'string' } } },
            },
            { name: 'fail', inputSchema: { type: 'object' } },
            { name: 'slow', inputSchema: { type: 'object' } },
            { name: 'hidden', inputSchema: { type: 'object' } },
        ],
    }))
    remote.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
        if (request.params.name === 'fail') throw new McpError(ErrorCode.InvalidParams, 'remote failure')
        if (request.params.name === 'hidden') hiddenCalls++
        if (request.params.name === 'slow') {
            markSlowStarted()
            await new Promise((_, reject) =>
                extra.signal.addEventListener(
                    'abort',
                    () => {
                        cancelled = true
                        reject(extra.signal.reason)
                    },
                    { once: true },
                ),
            )
        }
        if (request.params._meta?.progressToken !== undefined) {
            await extra.sendNotification({
                method: 'notifications/progress',
                params: { progressToken: request.params._meta.progressToken, progress: 1, total: 1 },
            })
        }
        const structuredContent = { value: request.params.arguments?.value }
        return { content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent }
    })
    await remote.connect(remoteServerTransport)
    await startBridge(bridgeRemoteTransport, bridgeLocalTransport, new Set(['echo', 'fail', 'slow']))

    let changes = 0
    const local = new Client({ name: 'test', version: '1.0.0' })
    local.setNotificationHandler(ToolListChangedNotificationSchema, () => {
        changes++
    })
    await local.connect(localClientTransport)
    t.after(async () => {
        await local.close()
        await remote.close()
    })

    const listed = await local.listTools()
    assert.deepEqual(
        listed.tools.map((tool) => tool.name),
        ['echo', 'fail', 'slow'],
    )
    assert.equal(listed.tools[0].description, 'remote v1')
    assert.deepEqual(listed.tools[0].outputSchema, {
        type: 'object',
        properties: { value: { type: 'string' } },
    })

    let progress
    const result = await local.callTool(
        { name: 'echo', arguments: { value: 'ok' } },
        undefined,
        { onprogress: (value) => (progress = value) },
    )
    assert.deepEqual(result.structuredContent, { value: 'ok' })
    assert.deepEqual(progress, { progress: 1, total: 1 })
    await assert.rejects(local.callTool({ name: 'fail' }), (error) => {
        assert.equal(error.code, ErrorCode.InvalidParams)
        assert.match(error.message, /remote failure/)
        return true
    })
    await assert.rejects(local.callTool({ name: 'hidden' }), (error) => {
        assert.equal(error.code, ErrorCode.InvalidParams)
        assert.match(error.message, /Tool is not enabled/)
        return true
    })
    assert.equal(hiddenCalls, 0)

    description = 'remote v2'
    await remote.sendToolListChanged()
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(changes, 1)
    assert.equal((await local.listTools()).tools[0].description, 'remote v2')

    const controller = new AbortController()
    const call = local.callTool({ name: 'slow' }, undefined, { signal: controller.signal })
    await slowStarted
    controller.abort('test cancellation')
    await assert.rejects(call)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(cancelled, true)
})
