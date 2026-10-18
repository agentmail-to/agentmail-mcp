#!/usr/bin/env node
import { constants, realpathSync } from 'node:fs'
import { open, realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

import { AgentMailClient } from 'agentmail'
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
import { z } from 'zod'

const VERSION = '1.1.0'
const ENDPOINT = new URL('https://mcp.agentmail.to/mcp')
const BRIDGE_HEADER = 'node/1.1.0'
const USER_AGENT = 'agentmail-mcp-node/1.1.0'
const MAX_LOCAL_ATTACHMENT_BYTES = 6 * 1024 * 1024

type JsonObject = Record<string, unknown>

const EVENT_NOTIFICATION_METHOD = 'notifications/event-bridge/event'
const EventListRequestSchema = z.object({ method: z.literal('events/list'), params: z.object({}).optional() })
const EventSubscribeRequestSchema = z.object({
    method: z.literal('events/subscribe'),
    params: z.object({
        name: z.string(),
        arguments: z.record(z.string(), z.unknown()),
        delivery: z.object({ mode: z.literal('mcp') }),
    }),
})
const EventUnsubscribeRequestSchema = z.object({
    method: z.literal('events/unsubscribe'),
    params: z.object({
        name: z.string(),
        arguments: z.record(z.string(), z.unknown()),
        delivery: z.object({ mode: z.literal('mcp') }),
    }),
})

type LocalSubscription = { name: string; inboxId?: string }

export class LocalEventBridge {
    private readonly subscriptions = new Map<string, LocalSubscription>()
    private socket: Awaited<ReturnType<AgentMailClient['websockets']['connect']>> | undefined

    constructor(
        private readonly apiKey: string,
        private readonly send: (params: JsonObject) => Promise<void>,
    ) {}

    async subscribe(name: string, args: JsonObject) {
        const inboxId = args.inboxId
        if (inboxId !== undefined && (typeof inboxId !== 'string' || !inboxId)) {
            throw new McpError(ErrorCode.InvalidParams, 'arguments.inboxId must be a non-empty string')
        }
        this.subscriptions.set(`${name}:${inboxId ?? '*'}`, { name, inboxId: inboxId as string | undefined })
        // The SDK retains the filters passed to sendSubscribe after reconnect.
        // Recreate it when the subscription set changes so it never keeps a
        // stale, narrower filter from the first action.
        this.socket?.close()
        this.socket = undefined
        await this.ensureConnected()
        return { id: `local:${name}:${inboxId}` }
    }

    async unsubscribe(name: string, args: JsonObject) {
        const inboxId = args.inboxId
        if (inboxId !== undefined && typeof inboxId !== 'string') {
            throw new McpError(ErrorCode.InvalidParams, 'arguments.inboxId must be a string')
        }
        this.subscriptions.delete(`${name}:${inboxId ?? '*'}`)
        this.socket?.close()
        this.socket = undefined
        if (this.subscriptions.size > 0) await this.ensureConnected()
        return {}
    }

    async close() {
        this.socket?.close()
        this.socket = undefined
    }

    private async ensureConnected() {
        if (this.socket) return
        const client = new AgentMailClient({ apiKey: this.apiKey })
        this.socket = await client.websockets.connect({ autoReconnect: true })
        this.socket.on('message', (event) => void this.forward(event as unknown as JsonObject))
        this.socket.on('error', (error) => console.error(`AgentMail MCP: event WebSocket error: ${error.message}`))
        this.socket.sendSubscribe({
            type: 'subscribe',
            eventTypes: [...new Set([...this.subscriptions.values()].map((item) => item.name))] as never,
            inboxIds: (() => {
                const inboxIds = [
                    ...new Set(
                        [...this.subscriptions.values()]
                            .map((item) => item.inboxId)
                            .filter((inboxId): inboxId is string => typeof inboxId === 'string'),
                    ),
                ]
                return inboxIds.length ? inboxIds : undefined
            })(),
        })
    }

    private async forward(event: JsonObject) {
        const message = event.message as JsonObject | undefined
        const eventName = event.eventType
        const eventId = event.eventId
        const inboxId = message?.inboxId
        const messageId = message?.messageId
        if (
            typeof eventName !== 'string' ||
            typeof eventId !== 'string' ||
            typeof inboxId !== 'string' ||
            typeof messageId !== 'string' ||
            (!this.subscriptions.has(`${eventName}:${inboxId}`) && !this.subscriptions.has(`${eventName}:*`))
        )
            return
        await this.send({
            eventId,
            source: 'agentmail',
            event: eventName,
            timestamp: new Date().toISOString(),
            data: { inboxId, messageId },
        })
    }
}

export type ValidatedFileRoot = {
    path: string
    device: bigint
    inode: bigint
}

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
                    'Path to a local file inside the configured --file-root. Available only through the local stdio bridge.',
            },
        },
        required: ['path'],
        additionalProperties: false,
    }
}

export function addLocalFileAttachmentVariant(tool: JsonObject): JsonObject {
    const inputSchema = tool.inputSchema as JsonObject | undefined
    const properties = inputSchema?.properties as JsonObject | undefined
    const attachments = properties?.attachments as JsonObject | undefined
    const items = attachments?.items as JsonObject | undefined
    const variants = items?.anyOf as JsonObject[] | undefined
    if (!variants?.length) return tool
    if (variants.some((variant) => Array.isArray(variant.required) && variant.required.includes('path'))) return tool

    const contentVariant = variants.find(
        (variant) => Array.isArray(variant.required) && variant.required.includes('content'),
    )
    if (!contentVariant) return tool

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
                        anyOf: [...variants, localFileVariant(contentVariant)],
                    },
                },
            },
        },
    }
}

function isWithinRoot(root: string, candidate: string) {
    const pathFromRoot = relative(root, candidate)
    return pathFromRoot === '' || (pathFromRoot !== '..' && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot))
}

function hasHiddenPathSegment(path: string) {
    return path.split(/[\\/]/).some((part) => part.startsWith('.') && part !== '.' && part !== '..')
}

function hasLocalFileAttachments(arguments_: JsonObject | undefined) {
    return (
        Array.isArray(arguments_?.attachments) &&
        arguments_.attachments.some((value) => value && typeof value === 'object' && 'path' in value)
    )
}

export async function validateFileRoot(fileRoot: string) {
    if (!isAbsolute(fileRoot)) throw new Error('--file-root must be an absolute directory path')

    let canonicalRoot: string
    try {
        canonicalRoot = await realpath(fileRoot)
    } catch {
        throw new Error('--file-root must reference an existing directory')
    }
    const rootStat = await stat(canonicalRoot, { bigint: true })
    if (!rootStat.isDirectory()) throw new Error('--file-root must reference a directory')
    return { path: canonicalRoot, device: rootStat.dev, inode: rootStat.ino }
}

async function assertFileRootUnchanged(fileRoot: ValidatedFileRoot) {
    try {
        const currentPath = await realpath(fileRoot.path)
        const currentStat = await stat(currentPath, { bigint: true })
        if (
            currentPath !== fileRoot.path ||
            !currentStat.isDirectory() ||
            currentStat.dev !== fileRoot.device ||
            currentStat.ino !== fileRoot.inode
        ) {
            throw new Error('changed')
        }
    } catch {
        throw new McpError(
            ErrorCode.InvalidParams,
            'Configured --file-root has changed since the bridge started; restart the bridge to authorize a new root',
        )
    }
}

function sameFile(
    left: { dev: bigint; ino: bigint },
    right: { dev: bigint; ino: bigint },
) {
    return left.dev === right.dev && left.ino === right.ino
}

async function readOpenedFileWithinLimit(
    handle: Awaited<ReturnType<typeof open>>,
    remainingBytes: number,
) {
    const chunks: Buffer[] = []
    let bytesRead = 0
    while (bytesRead <= remainingBytes) {
        const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remainingBytes + 1 - bytesRead))
        const result = await handle.read(chunk, 0, chunk.length, null)
        if (result.bytesRead === 0) break
        chunks.push(chunk.subarray(0, result.bytesRead))
        bytesRead += result.bytesRead
    }
    if (bytesRead > remainingBytes) {
        throw new McpError(
            ErrorCode.InvalidParams,
            'Local attachments exceed the 6 MiB combined limit for an inline MCP request',
        )
    }
    return Buffer.concat(chunks, bytesRead)
}

export async function resolveLocalFileAttachments(
    arguments_: JsonObject | undefined,
    fileRoot: ValidatedFileRoot,
): Promise<JsonObject | undefined> {
    if (!Array.isArray(arguments_?.attachments)) return arguments_

    await assertFileRootUnchanged(fileRoot)
    const canonicalRoot = fileRoot.path
    let totalBytes = 0
    const attachments: unknown[] = []
    for (const [index, value] of arguments_.attachments.entries()) {
        if (!value || typeof value !== 'object' || !('path' in value)) {
            attachments.push(value)
            continue
        }

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

        const unresolved = resolve(canonicalRoot, attachment.path)
        if (!isWithinRoot(canonicalRoot, unresolved)) {
            throw new McpError(ErrorCode.InvalidParams, `attachments[${index}].path is outside --file-root`)
        }
        const requestedRelativePath = relative(canonicalRoot, unresolved)
        if (hasHiddenPathSegment(requestedRelativePath)) {
            throw new McpError(
                ErrorCode.InvalidParams,
                `attachments[${index}].path cannot contain hidden files or directories`,
            )
        }

        let candidate: string
        try {
            candidate = await realpath(unresolved)
        } catch {
            throw new McpError(ErrorCode.InvalidParams, `attachments[${index}].path does not exist or cannot be read`)
        }
        if (!isWithinRoot(canonicalRoot, candidate)) {
            throw new McpError(ErrorCode.InvalidParams, `attachments[${index}].path is outside --file-root`)
        }
        if (hasHiddenPathSegment(relative(canonicalRoot, candidate))) {
            throw new McpError(
                ErrorCode.InvalidParams,
                `attachments[${index}].path cannot resolve through hidden files or directories`,
            )
        }

        let handle: Awaited<ReturnType<typeof open>>
        try {
            handle = await open(candidate, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
        } catch {
            throw new McpError(ErrorCode.InvalidParams, `attachments[${index}].path changed or cannot be read`)
        }
        try {
            const openedStat = await handle.stat({ bigint: true })
            if (!openedStat.isFile()) {
                throw new McpError(ErrorCode.InvalidParams, `attachments[${index}].path is not a regular file`)
            }

            // Validate the path again after opening, then only read through the validated handle.
            // This prevents a symlink or rename swap between path validation and file reading.
            const currentCandidate = await realpath(unresolved)
            const currentStat = await stat(currentCandidate, { bigint: true })
            await assertFileRootUnchanged(fileRoot)
            if (
                currentCandidate !== candidate ||
                !isWithinRoot(canonicalRoot, currentCandidate) ||
                !sameFile(openedStat, currentStat)
            ) {
                throw new McpError(ErrorCode.InvalidParams, `attachments[${index}].path changed while being read`)
            }

            const content = await readOpenedFileWithinLimit(handle, MAX_LOCAL_ATTACHMENT_BYTES - totalBytes)
            totalBytes += content.length
            const { path: _path, ...metadata } = attachment
            attachments.push({
                ...metadata,
                filename: attachment.filename ?? basename(attachment.path),
                content: content.toString('base64'),
            })
        } catch (error) {
            if (error instanceof McpError) throw error
            throw new McpError(ErrorCode.InvalidParams, `attachments[${index}].path changed or cannot be read`)
        } finally {
            await handle.close()
        }
    }

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
    apiKey?: string,
) {
    const canonicalFileRoot = fileRoot ? await validateFileRoot(fileRoot) : undefined
    const server = new Server(
        { name: 'agentmail-mcp', version: VERSION },
        { capabilities: { tools: { listChanged: true } } },
    )
    const client = new Client({ name: 'agentmail-mcp-node', version: VERSION })
    const events = apiKey
        ? new LocalEventBridge(apiKey, (params) => server.notification({ method: EVENT_NOTIFICATION_METHOD, params } as never))
        : undefined

    client.setNotificationHandler(ToolListChangedNotificationSchema, () => server.sendToolListChanged())
    server.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
        const result = await client.listTools(
            request.params,
            progressOptions(request.params?._meta?.progressToken, extra.signal, extra.sendNotification),
        )
        const visibleTools = tools ? result.tools.filter((tool) => tools.has(tool.name)) : result.tools
        return {
            ...result,
            tools: canonicalFileRoot
                ? visibleTools.map((tool) => addLocalFileAttachmentVariant(tool as JsonObject))
                : visibleTools,
        }
    })
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
        if (tools && !tools.has(request.params.name)) {
            throw new McpError(ErrorCode.InvalidParams, `Tool is not enabled: ${request.params.name}`)
        }
        const params = canonicalFileRoot && hasLocalFileAttachments(request.params.arguments)
            ? {
                  ...request.params,
                  arguments: await resolveLocalFileAttachments(request.params.arguments, canonicalFileRoot),
              }
            : request.params
        return client.callTool(
            params,
            undefined,
            progressOptions(request.params._meta?.progressToken, extra.signal, extra.sendNotification),
        )
    })
    ;(server as any).setRequestHandler(EventListRequestSchema, async () => ({
        events: [
            {
                name: 'message.received',
                description: 'An email arrived.',
                delivery: ['mcp'],
                inputSchema: { type: 'object', properties: { inboxId: { type: 'string' } }, required: ['inboxId'] },
            },
        ],
    }))
    ;(server as any).setRequestHandler(EventSubscribeRequestSchema, async (request: z.infer<typeof EventSubscribeRequestSchema>) => {
        if (!events) throw new McpError(ErrorCode.InvalidRequest, 'AGENTMAIL_API_KEY is required')
        return events.subscribe(request.params.name, request.params.arguments)
    })
    ;(server as any).setRequestHandler(EventUnsubscribeRequestSchema, async (request: z.infer<typeof EventUnsubscribeRequestSchema>) => {
        if (!events) throw new McpError(ErrorCode.InvalidRequest, 'AGENTMAIL_API_KEY is required')
        return events.unsubscribe(request.params.name, request.params.arguments)
    })

    server.onerror = (error) => console.error(`AgentMail MCP: stdio error: ${error.message}`)
    client.onerror = (error) => console.error(`AgentMail MCP: hosted error: ${error.message}`)
    server.onclose = () => {
        void events?.close()
        void client.close()
    }
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
    await startBridge(remote, new StdioServerTransport(), parseTools(args), parseFileRoot(args), apiKey)
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
