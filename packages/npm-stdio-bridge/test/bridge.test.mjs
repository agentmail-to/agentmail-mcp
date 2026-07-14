import assert from 'node:assert/strict'
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

import { parseTools, startBridge } from '../build/index.js'

test('parses the compatibility tool filter', () => {
    assert.equal(parseTools([]), undefined)
    assert.deepEqual([...parseTools(['--tools', 'one, two'])], ['one', 'two'])
    assert.throws(() => parseTools(['--tools']), /requires a comma-separated list/)
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
