#!/usr/bin/env node
import { realpathSync } from 'node:fs'
import { readFile, realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute, relative, resolve } from 'node:path'
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

const VERSION = '1.1.0'
const ENDPOINT = new URL('https://mcp.agentmail.to/mcp')
const BRIDGE_HEADER = 'node/1.1.0'
const USER_AGENT = 'agentmail-mcp-node/1.1.0'
const LOCAL_FILE_TOOLS = new Set(['send_message', 'reply_to_message', 'forward_message', 'create_draft'])
const MAX_LOCAL_ATTACHMENT_BYTES = 6 * 1024 * 1024

type JsonObject = Record<string, unknown>

function localFileVariant(baseVariant: JsonObject): JsonObject {
    const properties = (baseVariant.properties ?? {}) as JsonObject
    const { content: _content, url: _url, ...metadataProperties } = properties
    return {
        type: 'object',
        properties: {
            ...metadataProperties,
            path: {
                type: 'string',
                description:
                    'Path to a local file inside the MCP bridge working directory. Available only through the local stdio bridge.',
            },
        },
        required: ['path'],
        additionalProperties: false,
    }
}

export function addLocalFileAttachmentVariant(tool: JsonObject): JsonObject {
    if (!LOCAL_FILE_TOOLS.has(String(tool.name))) return tool

    const inputSchema = tool.inputSchema as JsonObject | undefined
    const properties = inputSchema?.properties as JsonObject | undefined
    const attachments = properties?.attachments as JsonObject | undefined
    const items = attachments?.items as JsonObject | undefined
    const variants = items?.anyOf as JsonObject[] | undefined
    if (!variants?.length) return tool

    return {
        ...tool,
        inputSchema: {
            ...inputSchema,
            properties: {
                ...properties,
                attachments: {
                    ...attachments,
                    description:
                        'Attachments. Through this local bridge, each item may use content (base64), a public url, or a local path.',
                    items: {
                        ...items,
                        anyOf: [...variants, localFileVariant(variants[0]!)],
                    },
                },
            },
        },
    }
}

function isWithinRoot(root: string, candidate: string) {
    const pathFromRoot = relative(root, candidate)
    return pathFromRoot === '' || (!pathFromRoot.startsWith('..') && !isAbsolute(pathFromRoot))
}

export async function resolveLocalFileAttachments(
    arguments_: JsonObject | undefined,
    fileRoot: string,
): Promise<JsonObject | undefined> {
    if (!Array.isArray(arguments_?.attachments)) return arguments_

    const canonicalRoot = await realpath(fileRoot)
    let totalBytes = 0
    const attachments = await Promise.all(
        arguments_.attachments.map(async (value, index) => {
            if (!value || typeof value !== 'object' || !('path' in value)) return value

            const attachment = value as JsonObject
            if (typeof attachment.path !== 'string' || !attachment.path) {
                throw new McpError(ErrorCode.InvalidParams, `attachments[${index}].path must be a non-empty string`)
            }
            if ('content' in attachment || 'url' in attachment) {
                throw new McpError(
                    ErrorCode.InvalidParams,
                    `attachments[${index}] must specify exactly one of path, content, or url`,
                )
            }

            const candidate = await realpath(resolve(canonicalRoot, attachment.path)).catch(() => undefined)
            if (!candidate || !isWithinRoot(canonicalRoot, candidate)) {
                throw new McpError(
                    ErrorCode.InvalidParams,
                    `attachments[${index}].path must resolve to a file inside ${canonicalRoot}`,
                )
            }

            const fileStat = await stat(candidate)
            if (!fileStat.isFile()) {
                throw new McpError(ErrorCode.InvalidParams, `attachments[${index}].path is not a regular file`)
            }
            totalBytes += fileStat.size
            if (totalBytes > MAX_LOCAL_ATTACHMENT_BYTES) {
                throw new McpError(
                    ErrorCode.InvalidParams,
                    'Local attachments exceed the 6 MiB combined limit for an inline MCP request',
                )
            }

            const { path: _path, ...metadata } = attachment
            return {
                ...metadata,
                filename: attachment.filename ?? basename(candidate),
                content: (await readFile(candidate)).toString('base64'),
            }
        }),
    )

    return { ...arguments_, attachments }
}

export function parseTools(args: string[]) {
    const index = args.indexOf('--tools')
    if (index === -1) return undefined

    const value = args[index + 1]
    if (!value) throw new Error('--tools requires a comma-separated list of tool names')
    return new Set(value.split(',').map((name) => name.trim()))
}

export function parseFileRoot(args: string[]) {
    const index = args.indexOf('--file-root')
    if (index === -1) return undefined

    const value = args[index + 1]
    if (!value) throw new Error('--file-root requires a directory path')
    return value
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

export async function startBridge(
    remoteTransport: Transport,
    localTransport: Transport,
    tools?: Set<string>,
    fileRoot?: string,
) {
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
        const visibleTools = tools ? result.tools.filter((tool) => tools.has(tool.name)) : result.tools
        return {
            ...result,
            tools: fileRoot
                ? visibleTools.map((tool) => addLocalFileAttachmentVariant(tool as JsonObject))
                : visibleTools,
        }
    })
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
        if (tools && !tools.has(request.params.name)) {
            throw new McpError(ErrorCode.InvalidParams, `Tool is not enabled: ${request.params.name}`)
        }
        const params = fileRoot && LOCAL_FILE_TOOLS.has(request.params.name)
            ? {
                  ...request.params,
                  arguments: await resolveLocalFileAttachments(request.params.arguments, fileRoot),
              }
            : request.params
        return client.callTool(
            params,
            undefined,
            progressOptions(request.params._meta?.progressToken, extra.signal, extra.sendNotification),
        )
    })

    server.onerror = (error) => console.error(`AgentMail MCP: stdio error: ${error.message}`)
    client.onerror = (error) => console.error(`AgentMail MCP: hosted error: ${error.message}`)
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
    const args = process.argv.slice(2)
    await startBridge(remote, new StdioServerTransport(), parseTools(args), parseFileRoot(args))
}

const entryUrl = process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href
if (entryUrl && import.meta.url === entryUrl) {
    main().catch((error) => {
        const message = error instanceof Error ? error.message : ''
        console.error(
            message === 'AGENTMAIL_API_KEY is required' || message.startsWith('--tools') || message.startsWith('--file-root')
                ? message
                : 'Failed to connect to the hosted AgentMail MCP server',
        )
        process.exitCode = 1
    })
}
