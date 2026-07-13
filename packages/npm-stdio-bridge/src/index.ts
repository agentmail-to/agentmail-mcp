#!/usr/bin/env node
import { pathToFileURL } from 'node:url'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import {
    CallToolRequestSchema,
    ErrorCode,
    ListToolsRequestSchema,
    McpError,
    ToolListChangedNotificationSchema,
    type Progress,
} from '@modelcontextprotocol/sdk/types.js'

const VERSION = '1.0.0'
const ENDPOINT = new URL('https://mcp.agentmail.to/mcp')
const BRIDGE_HEADER = 'node/1.0.0'
const USER_AGENT = 'agentmail-mcp-node/1.0.0'

export function parseTools(args: string[]) {
    const index = args.indexOf('--tools')
    if (index === -1) return undefined

    const value = args[index + 1]
    if (!value) throw new Error('--tools requires a comma-separated list of tool names')
    return new Set(value.split(',').map((name) => name.trim()))
}

function progressOptions(
    progressToken: string | number | undefined,
    signal: AbortSignal,
    sendNotification: (notification: {
        method: 'notifications/progress'
        params: Progress & { progressToken: string | number }
    }) => Promise<void>,
) {
    return {
        signal,
        ...(progressToken === undefined
            ? {}
            : {
                  onprogress: (progress: Progress) =>
                      sendNotification({
                          method: 'notifications/progress',
                          params: { ...progress, progressToken },
                      }),
              }),
    }
}

export async function startBridge(remoteTransport: Transport, localTransport: Transport, tools?: Set<string>) {
    const server = new Server(
        { name: 'agentmail-mcp', version: VERSION },
        { capabilities: { tools: { listChanged: true } } },
    )
    const client = new Client({ name: 'agentmail-mcp-node', version: VERSION })

    client.setNotificationHandler(ToolListChangedNotificationSchema, () => server.sendToolListChanged())
    server.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
        const result = await client.listTools(
            request.params,
            progressOptions(request.params?._meta?.progressToken, extra.signal, extra.sendNotification),
        )
        return tools ? { ...result, tools: result.tools.filter((tool) => tools.has(tool.name)) } : result
    })
    server.setRequestHandler(CallToolRequestSchema, (request, extra) => {
        if (tools && !tools.has(request.params.name)) {
            throw new McpError(ErrorCode.InvalidParams, `Tool is not enabled: ${request.params.name}`)
        }
        return client.callTool(
            request.params,
            undefined,
            progressOptions(request.params._meta?.progressToken, extra.signal, extra.sendNotification),
        )
    })

    server.onclose = () => void client.close()
    client.onclose = () => void server.close()
    await client.connect(remoteTransport)
    await server.connect(localTransport)
}

async function main() {
    const apiKey = process.env.AGENTMAIL_API_KEY
    if (!apiKey) throw new Error('AGENTMAIL_API_KEY is required')

    const remote = new StreamableHTTPClientTransport(ENDPOINT, {
        requestInit: {
            headers: {
                'x-api-key': apiKey,
                'X-AgentMail-MCP-Bridge': BRIDGE_HEADER,
                'User-Agent': USER_AGENT,
            },
        },
    })
    await startBridge(remote, new StdioServerTransport(), parseTools(process.argv.slice(2)))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        const message = error instanceof Error ? error.message : ''
        console.error(
            message === 'AGENTMAIL_API_KEY is required' || message.startsWith('--tools')
                ? message
                : 'Failed to connect to the hosted AgentMail MCP server',
        )
        process.exitCode = 1
    })
}
