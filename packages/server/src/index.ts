/**
 * AgentMail Remote MCP Server
 * ===========================
 *
 * Hosted on Manufact at https://mcp.agentmail.to.
 *
 * Auth model: dual-path, OAuth-or-API-key.
 *
 *   1. Clerk OAuth (preferred, modern clients like Claude Desktop):
 *      Client follows MCP 2025-06-18 OAuth discovery, registers itself via
 *      DCR against our Clerk instance, and arrives with an Authorization:
 *      Bearer <Clerk JWT>. We bridge that to a per-org console JWT and call
 *      the AgentMail backend with it (same path the console uses).
 *
 *   2. API key (legacy, existing Cursor users):
 *      Client passes ?apiKey=am_... or x-api-key header. We hand the key
 *      straight to AgentMailClient. No Clerk involvement.
 *
 * The two paths are checked in order. If neither is present, mcpAuthClerk
 * returns 401 + WWW-Authenticate to bootstrap the OAuth flow.
 */

import express from 'express'
import cors from 'cors'
import { clerkClient, clerkMiddleware } from '@clerk/express'
import {
    mcpAuthClerk,
    protectedResourceHandlerClerk,
    authServerMetadataHandlerClerk,
    streamableHttpHandler,
} from '@clerk/mcp-tools/express'
import { AgentMailClient } from 'agentmail'
import { AgentMailToolkit } from 'agentmail-toolkit/mcp'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { SignJWT } from 'jose'
import crypto from 'node:crypto'
import v8 from 'node:v8'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import fs from 'node:fs'
import { z } from 'zod'

// ============================================================================
// Config
// ============================================================================

const PORT = parseInt(process.env.PORT || '3000', 10)

// Accept-queue depth. app.listen(port) with no backlog argument uses Node's
// default of 511, which is the real cap regardless of the kernel's somaxconn.
//
// The 2026-08-20 outage was that cap overflowing. The Manufact/Fly proxy opens
// one connection per request and drives bursts well past the steady ~95/s; when
// a burst filled 511 in a single event-loop tick before the accept callback ran
// again, the kernel dropped the completed handshakes (ListenOverflows tracked it
// exactly, stepping 3378 → 4111 → 5729 during the incident), the proxy retried,
// and every retried request waited seconds — all upstream of Express, with the
// event loop near idle. Raising the backlog gives bursts somewhere to sit until
// the loop drains them. Bounded by the VM's somaxconn (4096 on Fly); 2048 leaves
// headroom without pretending the backlog can exceed what the kernel will honor.
const LISTEN_BACKLOG = Math.max(128, parseInt(process.env.AGENTMAIL_LISTEN_BACKLOG || '', 10) || 2048)
const DOCS_URL = 'https://docs.agentmail.to/integrations/mcp'
const OPENAI_APPS_CHALLENGE_TOKEN = 'x5q5TTetk6mOB_sFlNKxXnvES1T8slSZXyWOL-T2b1s'

// Where the AgentMail backend lives. Manufact env var should set this per
// deployment (staging vs prod). The previous behavior was an unset URL =
// SDK default; we keep that as the fallback.
const AGENTMAIL_API_URL = process.env.AGENTMAIL_API_URL
const AGENTMAIL_WS_URL = AGENTMAIL_API_URL?.replace('https://api.', 'wss://ws.')

const CLERK_ENABLED = Boolean(process.env.CLERK_PUBLISHABLE_KEY && process.env.CLERK_SECRET_KEY)

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

// Public URL of this MCP server (the URL that outside clients hit).
// Optional. When set, we force Express + @clerk/mcp-tools to use this as the
// base URL when composing self-referential URLs (WWW-Authenticate
// resource_metadata pointer, /.well-known/oauth-protected-resource body, etc).
//
// Required in deployments behind reverse proxies that rewrite the Host header
// to an internal hostname (fly.io does this — req.headers.host becomes
// mcp-cXXXX-N.fly.dev, which clients can't reach). Without MCP_PUBLIC_URL set
// in those environments, we'd emit a 401 WWW-Authenticate pointing to a
// hostname only reachable from inside fly's network.
//
// Examples:
//   Preview:     MCP_PUBLIC_URL=https://<preview-id>.run.mcp-use.com
//   Production:  MCP_PUBLIC_URL=https://mcp.agentmail.to
//   Local:       (don't set — Express uses localhost:3000 correctly)
const MCP_PUBLIC_URL = process.env.MCP_PUBLIC_URL?.replace(/\/$/, '')

// ============================================================================
// Console JWT signer
// (ported from agentmail-web/apps/console/app/lib/agentmail-jwt.server.ts)
//
// The AgentMail backend trusts ES256 JWTs signed by CONSOLE_JWT_PRIVATE_KEY
// with issuer=agentmail-console, audience=agentmail-api, subject=<orgId>.
// This is the same auth path the console uses every request.
//
// The env var CONSOLE_JWT_PRIVATE_KEY accepts EITHER:
//   - A raw multi-line PEM string (works for local .env files where
//     newlines are preserved)
//   - A single-line base64-encoded PEM (works for hosting platforms like
//     Manufact whose env var UI doesn't accept multi-line values)
// We auto-detect by sniffing for the PEM header.
// ============================================================================

function decodeConsoleJwtPem(envValue: string): string {
    // Raw PEM: starts with "-----BEGIN" (after possible whitespace).
    if (envValue.trimStart().startsWith('-----BEGIN')) {
        return envValue
    }
    // Otherwise treat as base64. Decode and validate the result looks like a PEM.
    let decoded: string
    try {
        decoded = Buffer.from(envValue, 'base64').toString('utf8')
    } catch (error) {
        throw new Error(`CONSOLE_JWT_PRIVATE_KEY is not raw PEM and base64 decode failed: ${error}`)
    }
    if (!decoded.trimStart().startsWith('-----BEGIN')) {
        throw new Error(
            'CONSOLE_JWT_PRIVATE_KEY does not look like raw PEM or base64-encoded PEM. ' +
                'Expected the decoded value to start with "-----BEGIN".'
        )
    }
    return decoded
}

function getConsoleJwtKeyObject() {
    const raw = process.env.CONSOLE_JWT_PRIVATE_KEY
    if (!raw) {
        throw new Error('CONSOLE_JWT_PRIVATE_KEY env var is required to use OAuth path')
    }
    const pem = decodeConsoleJwtPem(raw)
    try {
        return crypto.createPrivateKey({ key: pem, format: 'pem' })
    } catch (error) {
        throw new Error(`Failed to import CONSOLE_JWT_PRIVATE_KEY: ${error}`)
    }
}

/**
 * Sign a JWT the AgentMail backend will trust.
 *
 * @param organizationId  Either an AgentMail internal org id (normal request
 *                        path) OR a Clerk org id (bootstrap path for the
 *                        /v0/auth/internal-org lookup itself).
 */
async function signConsoleJwt(organizationId: string): Promise<string> {
    const privateKey = getConsoleJwtKeyObject()
    const now = Math.floor(Date.now() / 1000)

    return await new SignJWT({ organizationId })
        .setProtectedHeader({ alg: 'ES256' })
        .setIssuer('agentmail-console')
        .setAudience('agentmail-api')
        .setSubject(organizationId)
        .setIssuedAt(now)
        .setExpirationTime(now + 24 * 60 * 60)
        .setJti(crypto.randomUUID())
        .sign(privateKey)
}

type InternalOrganizationLookupDependencies = {
    apiUrl: string | undefined
    signToken: (clerkOrgId: string) => Promise<string>
    fetcher: typeof fetch
    sleep: (ms: number) => Promise<void>
    retryDelaysMs: readonly number[]
}

export const INTERNAL_ORG_RETRY_DELAYS_MS = [100, 250, 500, 1_000, 2_000, 2_000] as const

function isOrganizationMappingUnavailable(status: number, body: string): boolean {
    // Compatibility with the previously deployed /internal-org behavior.
    if (status === 403) return true
    if (status !== 404) return false

    try {
        const error = JSON.parse(body) as { code?: unknown; message?: unknown }
        return error.code === 'not_found' && error.message === 'Organization not found'
    } catch {
        return false
    }
}

/**
 * Resolve AgentMail internal org id from a Clerk org id.
 * Mirrors console/app/lib/agentmail-jwt.server.ts lookupOrganization.
 *
 * Clerk emits organization.created asynchronously. A newly-created Clerk org
 * can therefore be visible to the MCP server shortly before the AgentMail
 * organization webhook has written its mapping. Retry only responses that
 * identify that expected window; other upstream failures surface immediately.
 */
export async function getInternalOrganizationId(
    clerkOrgId: string,
    dependencies?: InternalOrganizationLookupDependencies
): Promise<string> {
    const { apiUrl, signToken, fetcher, sleep: wait, retryDelaysMs } = dependencies ?? {
        apiUrl: AGENTMAIL_API_URL,
        signToken: signConsoleJwt,
        fetcher: fetch,
        sleep,
        retryDelaysMs: INTERNAL_ORG_RETRY_DELAYS_MS,
    }
    if (!apiUrl) {
        throw new Error('AGENTMAIL_API_URL env var is required to use OAuth path')
    }

    const bootstrapJwt = await signToken(clerkOrgId)
    for (let attempt = 0; ; attempt += 1) {
        const response = await fetcher(`${apiUrl}/v0/auth/internal-org`, {
            method: 'GET',
            headers: { Authorization: `Bearer ${bootstrapJwt}` },
        })

        if (response.ok) {
            const data = (await response.json()) as { organization_id?: string }
            if (!data.organization_id) {
                throw new Error('No organization_id in /v0/auth/internal-org response')
            }
            return data.organization_id
        }

        const body = await response.text()
        const retryable = isOrganizationMappingUnavailable(response.status, body)
        if (!retryable) {
            throw new Error(`/v0/auth/internal-org failed: ${response.status} ${body}`)
        }
        if (attempt >= retryDelaysMs.length) {
            console.warn('[auth] AgentMail organization mapping is still unavailable', {
                clerkOrganizationId: clerkOrgId,
                status: response.status,
                body,
            })
            throw new Error(
                'Your AgentMail workspace is still provisioning. Retry this tool in a few seconds.'
            )
        }
        await wait(retryDelaysMs[attempt]!)
    }
}

/**
 * Extract the `org_id` claim from a Clerk OAuth access token.
 *
 * Clerk surfaces the user's selected organization as the `org_id` claim
 * when the OAuth app was granted the `user:org:read` scope AND the user
 * picked an org on the consent screen (Clerk early-access feature, rolled
 * out April 2026). The @clerk/mcp-tools mcpAuthClerk wrapper does NOT
 * propagate this claim into the AuthInfo object — only userId is exposed
 * via extra — so we decode the raw JWT payload ourselves.
 *
 * Returns undefined for tokens issued before user:org:read was enabled,
 * tokens that omit the claim, or any decode failure. Callers must handle
 * the undefined case via membership lookup, with a strict multi-org
 * fallback to avoid silently picking the wrong org.
 */
function extractOrgIdFromClerkToken(token: string | undefined): string | undefined {
    if (!token) return undefined
    try {
        const parts = token.split('.')
        if (parts.length < 2) return undefined
        const payload = JSON.parse(Buffer.from(parts[1]!, 'base64').toString()) as Record<
            string,
            unknown
        >
        const orgId = payload.org_id
        return typeof orgId === 'string' ? orgId : undefined
    } catch {
        return undefined
    }
}

// Clerk user privateMetadata key that stores the org a multi-org user selected
// via the `select_organization` MCP tool. privateMetadata (not public) because
// it's an internal routing setting, never exposed to the frontend or the token.
const MCP_SELECTED_ORG_KEY = 'mcpSelectedOrgId'

/** Read the user's previously-selected org id from Clerk privateMetadata. */
async function getStoredMcpOrgId(clerkUserId: string): Promise<string | undefined> {
    const user = await clerkClient.users.getUser(clerkUserId)
    const stored = (user.privateMetadata as Record<string, unknown>)?.[MCP_SELECTED_ORG_KEY]
    return typeof stored === 'string' && stored ? stored : undefined
}

/** Persist the user's org selection to Clerk privateMetadata. */
async function setStoredMcpOrgId(clerkUserId: string, orgId: string): Promise<void> {
    await clerkClient.users.updateUserMetadata(clerkUserId, {
        privateMetadata: { [MCP_SELECTED_ORG_KEY]: orgId },
    })
}

/**
 * Build an AgentMailClient backed by a console JWT for the user's selected org.
 *
 * Selection rules (in precedence order):
 *   1. If `selectedClerkOrgId` is provided (token carried an `org_id` claim —
 *      the user picked an org on the Clerk consent screen): use it. Validate
 *      membership defensively. Currently only Claude's privileged app can emit
 *      this; DCR clients never do (Clerk doesn't grant them user:org:read).
 *   2. Else if the user belongs to exactly one org: use it (single-org users
 *      never need to choose).
 *   3. Else (multi-org user) consult the org they picked via `select_organization`
 *      (stored in Clerk privateMetadata). If set and still a valid membership,
 *      use it.
 *   4. Else: refuse. Silently picking memberships[0] could land destructive ops
 *      (e.g. delete_inbox) in the wrong org. Throw a clear error listing the
 *      orgs and telling the user to call `select_organization` first.
 *
 * Zero memberships is anomalous because Clerk normally creates a user's first
 * organization during sign-up. The MCP server does not create organizations;
 * users recover through the console's manual setup flow.
 *
 * This makes multi-org work for every client (Claude/Cursor/Codex) without
 * depending on the Clerk consent-screen org picker or per-client UA hacks.
 */
async function buildClientFromClerkUser(
    clerkUserId: string,
    selectedClerkOrgId?: string,
    signal?: AbortSignal
): Promise<AgentMailClient> {
    const memberships = await clerkClient.users.getOrganizationMembershipList({
        userId: clerkUserId,
    })
    if (!memberships.data || memberships.data.length === 0) {
        throw new Error(
            'Your account has no AgentMail Organization yet. Sign in once at ' +
                'https://console.agentmail.to to finish setup, then retry this tool.'
        )
    }

    let chosenOrg
    if (selectedClerkOrgId) {
        // Path 1: token specified an org. Validate membership before trusting it.
        const matching = memberships.data.find(
            (m) => m.organization.id === selectedClerkOrgId
        )
        if (!matching) {
            throw new Error(
                `User ${clerkUserId} is not a member of organization ${selectedClerkOrgId}. ` +
                    `Token claim does not match Clerk membership records.`
            )
        }
        chosenOrg = matching.organization
    } else if (memberships.data.length === 1) {
        // Path 2: single-org user. Safe to pick the only org.
        chosenOrg = memberships.data[0]!.organization
    } else {
        // Path 3/4: multi-org user, no org_id in token. Use the org they picked
        // via `select_organization`; otherwise refuse and tell them to pick one.
        const storedOrgId = await getStoredMcpOrgId(clerkUserId)
        const matching = storedOrgId
            ? memberships.data.find((m) => m.organization.id === storedOrgId)
            : undefined
        if (!matching) {
            const orgList = memberships.data
                .map((m) => `  - ${m.organization.name} (${m.organization.id})`)
                .join('\n')
            throw new Error(
                `You belong to ${memberships.data.length} organizations and haven't selected one yet. ` +
                    `Call the \`select_organization\` tool with one of these, then retry:\n${orgList}`
            )
        }
        chosenOrg = matching.organization
    }

    const meta = chosenOrg.publicMetadata as Record<string, unknown>
    let internalOrgId = meta?.internalOrgId as string | undefined
    if (!internalOrgId) {
        internalOrgId = await getInternalOrganizationId(chosenOrg.id)
    }

    const consoleJwt = await signConsoleJwt(internalOrgId)
    return new AgentMailClient({
        environment: AGENTMAIL_API_URL
            ? { http: AGENTMAIL_API_URL, websockets: AGENTMAIL_WS_URL || '' }
            : undefined,
        apiKey: consoleJwt,
        fetch: fetchBoundTo(signal),
    })
}

/**
 * Wrap fetch so every AgentMail request inherits the MCP request's cancellation.
 *
 * agentmail-toolkit does not forward `extra.signal` into the SDK, so without
 * this a client that disconnects leaves its AgentMail HTTP request running to
 * completion. That is invisible work: the connection is gone, nothing will read
 * the response, and the retry the client just issued adds another one on top.
 * Measured directly — after aborting a streamed tool call, the upstream socket
 * stayed open indefinitely while the server reported zero in flight.
 *
 * The SDK takes a custom `fetch` at construction and we build a client per tool
 * call, so injecting the signal here reaches every request the toolkit makes
 * without the toolkit having to cooperate.
 */
function fetchBoundTo(signal: AbortSignal | undefined): typeof fetch | undefined {
    if (!signal) return undefined
    return (input, init) => {
        const callerSignal = init?.signal
        return fetch(input, {
            ...init,
            signal: callerSignal ? AbortSignal.any([callerSignal, signal]) : signal,
        })
    }
}

/**
 * Build an AgentMailClient from a raw API key (legacy path).
 */
function buildClientFromApiKey(apiKey: string, signal?: AbortSignal): AgentMailClient {
    return new AgentMailClient({
        environment: AGENTMAIL_API_URL
            ? { http: AGENTMAIL_API_URL, websockets: AGENTMAIL_WS_URL || '' }
            : undefined,
        apiKey,
        fetch: fetchBoundTo(signal),
    })
}

// ============================================================================
// MCP server factory
//
// One server per request, parameterized by the auth source. We DO NOT eagerly
// build the AgentMailClient here because for tools/list we don't need it; we
// only build it inside the tool callback when the tool is actually invoked.
// ============================================================================

type AuthSource =
    | { kind: 'clerk'; clerkUserId: string; clerkOrgId?: string }
    | { kind: 'apiKey'; apiKey: string }
    | { kind: 'none' }

// Tool definitions are static metadata (name/description/schemas) — identical
// for every request — so enumerate them once at module load. Previously each
// incoming request built its own placeholder AgentMailClient + AgentMailToolkit
// just to enumerate tools, and long-lived SSE connections retained that whole
// per-request graph until close, which amplified the 2026-07-21 reconnect-storm
// heap exhaustion. The real, per-auth client is still built inside the tool
// callback at invocation time.
const staticToolkit = new AgentMailToolkit(new AgentMailClient({ apiKey: 'placeholder' }))
// auth_me is excluded from the HOSTED catalog only (it stays in the toolkit for
// other integrations): it returns organization/pod/API-key identifiers, which
// OpenAI app review treats as unnecessary internal identifiers on this surface —
// disclosure cannot cure "unnecessary". Hosted sessions get org context via
// list_organizations/select_organization instead.
const STATIC_TOOLS = staticToolkit.getTools().filter((tool) => tool.name !== 'auth_me')

export function createMcpServer(auth: AuthSource): McpServer {
    const server = new McpServer({ name: 'AgentMail', version: '1.0.0' })

    const noAuthMessage = {
        content: [
            {
                type: 'text' as const,
                text:
                    'Not authenticated. Sign in via OAuth, or provide an API key via ' +
                    '?apiKey=YOUR_KEY query param, x-api-key header, or Authorization: Bearer am_... ' +
                    'Get an API key at https://console.agentmail.to.',
            },
        ],
        // isError so clients surface it as an actionable failure instead of a
        // success payload that models may misread as tool output.
        isError: true,
    }

    for (const tool of STATIC_TOOLS) {
        server.registerTool(tool.name, tool, async (args, extra) => {
            try {
                let client: AgentMailClient
                if (auth.kind === 'clerk') {
                    client = await buildClientFromClerkUser(
                        auth.clerkUserId,
                        auth.clerkOrgId,
                        extra?.signal
                    )
                } else if (auth.kind === 'apiKey') {
                    client = buildClientFromApiKey(auth.apiKey, extra?.signal)
                } else {
                    return noAuthMessage
                }

                // Re-bind the tool's callback to our per-call client. The
                // toolkit's tools were created with the placeholder client;
                // we need to call them with the real one. We do this by
                // creating a fresh toolkit + tool for this call.
                const realToolkit = new AgentMailToolkit(client)
                const realTool = realToolkit.getTools().find((t) => t.name === tool.name)
                if (!realTool) {
                    return {
                        content: [{ type: 'text' as const, text: `Tool ${tool.name} not found in toolkit` }],
                        isError: true,
                    }
                }
                return realTool.callback(args, extra)
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error)
                console.error(`[mcp] tool ${tool.name} failed:`, error)
                return {
                    content: [{ type: 'text' as const, text: `Error: ${message}` }],
                    isError: true,
                }
            }
        })
    }

    // Org-selection tools (Clerk OAuth only). Let a multi-org user choose which
    // org their mail operations target, without relying on the Clerk consent
    // picker (which DCR clients can't use) or any per-client UA hack. The choice
    // persists in Clerk privateMetadata and applies to all future requests until
    // changed. See buildClientFromClerkUser path 3/4.
    if (CLERK_ENABLED) {
        const NON_CLERK_MSG =
            'Organization selection only applies to OAuth (Clerk) sessions. ' +
            "API-key requests are already scoped to that key's organization."

        server.registerTool(
            'list_organizations',
            {
                title: 'List organizations',
                description:
                    'List the organizations you belong to and show which one is currently ' +
                    'selected for AgentMail operations. Use `select_organization` to change it. ' +
                    'OAuth sessions only -- API-key requests return an error explaining that ' +
                    'organization selection does not apply to API-key authentication.',
                outputSchema: {
                    organizations: z.array(
                        z.object({
                            id: z.string(),
                            name: z.string(),
                            selected: z.boolean(),
                        })
                    ),
                },
                annotations: {
                    title: 'List organizations',
                    readOnlyHint: true,
                    destructiveHint: false,
                    idempotentHint: true,
                    openWorldHint: false,
                },
            },
            async () => {
                if (auth.kind !== 'clerk') {
                    // Not applicable outside an OAuth session -- isError so it doesn't need
                    // to satisfy outputSchema, and so it's flagged as actionable to the model.
                    return { content: [{ type: 'text' as const, text: NON_CLERK_MSG }], isError: true }
                }
                try {
                    const memberships = await clerkClient.users.getOrganizationMembershipList({
                        userId: auth.clerkUserId,
                    })
                    // Report the EFFECTIVE org, mirroring buildClientFromClerkUser's
                    // precedence (token-pinned > single-org auto-pick > stored choice) —
                    // previously only the stored choice was reported, so pinned and
                    // single-org sessions showed nothing selected.
                    const membershipData = memberships.data ?? []
                    const stored =
                        auth.clerkOrgId || membershipData.length === 1
                            ? undefined
                            : await getStoredMcpOrgId(auth.clerkUserId)
                    const selected =
                        auth.clerkOrgId ??
                        (membershipData.length === 1 ? membershipData[0]!.organization.id : stored)
                    const organizations = membershipData.map((m) => ({
                        id: m.organization.id,
                        name: m.organization.name,
                        selected: m.organization.id === selected,
                    }))
                    const structuredContent = { organizations }
                    return {
                        content: [{ type: 'text' as const, text: JSON.stringify(structuredContent) }],
                        structuredContent,
                    }
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error)
                    console.error('[mcp] tool list_organizations failed:', error)
                    return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true }
                }
            }
        )

        server.registerTool(
            'select_organization',
            {
                title: 'Select organization',
                description:
                    'Choose which organization your AgentMail operations target (for users who ' +
                    'belong to multiple orgs). Accepts an organization name or ID. The choice ' +
                    'persists across unpinned sessions until you change it; a session already ' +
                    'pinned to an organization by OAuth must be reconnected to change it. OAuth ' +
                    'sessions only -- API-key requests return an error explaining that ' +
                    'organization selection does not apply to API-key authentication.',
                inputSchema: {
                    organization: z
                        .string()
                        .describe('Organization name or ID (see `list_organizations`)'),
                },
                outputSchema: {
                    organizationId: z.string(),
                    organizationName: z.string(),
                },
                annotations: {
                    title: 'Select organization',
                    readOnlyHint: false,
                    destructiveHint: false,
                    idempotentHint: true,
                    openWorldHint: false,
                },
            },
            async ({ organization }) => {
                if (auth.kind !== 'clerk') {
                    // Not applicable outside an OAuth session -- isError so it doesn't need
                    // to satisfy outputSchema, and so it's flagged as actionable to the model.
                    return { content: [{ type: 'text' as const, text: NON_CLERK_MSG }], isError: true }
                }
                try {
                    const memberships = await clerkClient.users.getOrganizationMembershipList({
                        userId: auth.clerkUserId,
                    })
                    const query = organization.trim().toLowerCase()
                    const match = (memberships.data ?? []).find(
                        (m) =>
                            m.organization.id.toLowerCase() === query ||
                            m.organization.name.toLowerCase() === query
                    )
                    if (!match) {
                        const orgList = (memberships.data ?? [])
                            .map((m) => `  - ${m.organization.name} (${m.organization.id})`)
                            .join('\n')
                        return {
                            content: [
                                {
                                    type: 'text' as const,
                                    text: `No organization matching "${organization}". You belong to:\n${orgList}`,
                                },
                            ],
                            isError: true,
                        }
                    }
                    // A token-pinned session routes by its org_id claim regardless of the
                    // stored choice (buildClientFromClerkUser path 1), so selecting a
                    // DIFFERENT org would silently not take effect — refuse instead.
                    // Selecting the already-pinned org is a truthful no-op.
                    if (auth.clerkOrgId && auth.clerkOrgId !== match.organization.id) {
                        return {
                            content: [
                                {
                                    type: 'text' as const,
                                    text:
                                        'This OAuth session is pinned to a different organization. ' +
                                        'Reconnect and choose the intended organization, then retry.',
                                },
                            ],
                            isError: true,
                        }
                    }
                    if (!auth.clerkOrgId) {
                        await setStoredMcpOrgId(auth.clerkUserId, match.organization.id)
                    }
                    const structuredContent = {
                        organizationId: match.organization.id,
                        organizationName: match.organization.name,
                    }
                    return {
                        content: [{ type: 'text' as const, text: JSON.stringify(structuredContent) }],
                        structuredContent,
                    }
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error)
                    console.error('[mcp] tool select_organization failed:', error)
                    return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true }
                }
            }
        )
    }

    return server
}

// ============================================================================
// Auth detection middleware
//
// Decides which auth path a request is on, BEFORE Clerk's mcpAuthClerk gets
// to reject it. Sets req.authSource for downstream use.
//
//   1. Has ?apiKey, x-api-key, Authorization: Bearer am_..., or env
//      AGENTMAIL_API_KEY  → AuthSource.apiKey (skip Clerk; the legacy fast path)
//   2. CLERK_ENABLED and request has a (non-am_) Authorization header → run
//      mcpAuthClerk (it will validate the Clerk JWT and stash userId in authInfo)
//   3. Neither: still run mcpAuthClerk so it 401s with WWW-Authenticate,
//      bootstrapping the OAuth discovery flow
// ============================================================================

// Module augmentation: @types/express re-exports Request from
// express-serve-static-core, so the augmentation has to target the
// underlying module name, not 'express'. This is a known @types/express
// gotcha — augmenting 'express' attaches the prop to the wrong Request
// interface and tsc doesn't see it on actual req objects.
declare module 'express-serve-static-core' {
    interface Request {
        authSource?: AuthSource
    }
}

function extractApiKey(req: express.Request): string | undefined {
    const fromQuery = req.query.apiKey as string | undefined
    const fromHeader = req.headers['x-api-key'] as string | undefined
    // Accept `Authorization: Bearer am_...` as an API key. AgentMail keys carry
    // the `am_` prefix, which cleanly distinguishes them from Clerk OAuth access
    // tokens (JWTs), so this routes am_ keys to the API-key path without
    // shadowing OAuth. Without it, an am_ key sent as a Bearer token falls
    // through to mcpAuthClerk and is misrouted to the OAuth flow.
    const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1]
    const fromBearer = bearer?.startsWith('am_') ? bearer : undefined
    // Server-wide AGENTMAIL_API_KEY is the lowest-priority fallback and ONLY
    // applies when the request has no Authorization header. Without this
    // guard, an inbound Clerk OAuth Bearer token would be silently shadowed
    // by AGENTMAIL_API_KEY and the request would be processed as that key's
    // owner instead of the OAuth user's identity.
    const fromEnv = req.headers.authorization ? undefined : process.env.AGENTMAIL_API_KEY
    return fromQuery || fromHeader || fromBearer || fromEnv
}

/**
 * 401 challenge identical in shape to the one @clerk/mcp-tools sends for a
 * missing Authorization header (status, WWW-Authenticate resource_metadata
 * pointer, body), so OAuth clients re-enter the discovery flow the same way
 * in both cases. URL composition mirrors getPRMUrl in @clerk/mcp-tools.
 */
function sendOAuthChallenge(req: express.Request, res: express.Response) {
    const prmUrl = `${req.protocol}://${req.get('host')}/.well-known/oauth-protected-resource${req.originalUrl}`
    res.status(401)
        .set({ 'WWW-Authenticate': `Bearer resource_metadata=${prmUrl}` })
        .json({ error: 'Unauthorized' })
}

const authRouter: express.RequestHandler = async (req, res, next) => {
    const apiKey = extractApiKey(req)
    if (apiKey) {
        req.authSource = { kind: 'apiKey', apiKey }
        return next()
    }

    // No API key. If Clerk is configured, hand off to mcpAuthClerk for OAuth.
    if (CLERK_ENABLED) {
        // Reject malformed Authorization headers BEFORE mcpAuthClerk sees them.
        // Its inner mcpAuth middleware throws ("Invalid authorization header
        // value, expected Bearer <token>") when the header carries no token
        // after the scheme — e.g. a bare "Authorization: Bearer". Crucially,
        // mcpAuthClerk invokes that middleware as `(await mcpAuth(...))(req,
        // res, next)` WITHOUT awaiting the resulting promise, so the rejection
        // is detached from the chain Express 5 tracks: no try/catch or error
        // middleware can reach it, it surfaces as a process-level unhandled
        // rejection, and Node exits with code 1. That crash-looped production
        // three times on 2026-07-19 (10:03/10:13/10:14 UTC). The guard mirrors
        // mcpAuth's own parse (`header.split(' ')[1]` empty) so we 401 exactly
        // the requests that would otherwise kill the process.
        const authHeader = req.headers.authorization
        if (authHeader && !authHeader.split(' ')[1]) {
            // Don't log the header value: a token joined by non-space
            // whitespace would land here and must not reach the logs.
            console.warn('[auth] malformed Authorization header (no token after scheme), returning 401')
            return sendOAuthChallenge(req, res)
        }

        try {
            return await mcpAuthClerk(req, res, (err) => {
                if (err) {
                    // A failure inside the auth middleware is an auth failure:
                    // challenge the client instead of bubbling a 500.
                    console.error('[auth] mcpAuthClerk error:', err)
                    if (!res.headersSent) sendOAuthChallenge(req, res)
                    return
                }
                // mcpAuthClerk (from @clerk/mcp-tools) validates the Bearer token
                // as a Clerk OAuth access token and, on success, writes an MCP SDK
                // AuthInfo object directly to req.auth, OVERWRITING the function
                // set earlier by clerkMiddleware. The AuthInfo shape is:
                //   { token, scopes, clientId, extra: { userId } }
                // (see verifyClerkToken in @clerk/mcp-tools/dist/chunk-H4BXCCRK.js)
                //
                // IMPORTANT: do NOT use getAuth(req) from @clerk/express here —
                // that helper calls req.auth(options) expecting a session-token
                // getter function, but mcpAuthClerk has replaced req.auth with a
                // plain object, so getAuth() throws "TypeError: req.auth is not
                // a function". Read the userId directly from req.auth.extra.
                const authInfo = (
                    req as unknown as { auth?: { token?: string; extra?: { userId?: string } } }
                ).auth
                const userId = authInfo?.extra?.userId
                // Clerk's user:org:read scope puts the user's selected org in the
                // access token's `org_id` claim. The @clerk/mcp-tools wrapper
                // doesn't surface it, so we decode the raw token. Falls back to
                // undefined if the claim is missing — see buildClientFromClerkUser
                // for how that case is handled (single-org auto-pick vs multi-org
                // strict reject).
                const clerkOrgId = extractOrgIdFromClerkToken(authInfo?.token)
                if (userId) {
                    req.authSource = { kind: 'clerk', clerkUserId: userId, clerkOrgId }
                } else {
                    req.authSource = { kind: 'none' }
                }
                next()
            })
        } catch (error) {
            // Errors thrown on the awaited part of mcpAuthClerk (rare; the
            // detached-rejection path is handled by the guard above). Same
            // policy: auth-layer failure → 401 challenge, never a crash.
            console.error('[auth] mcpAuthClerk threw:', error)
            if (!res.headersSent) sendOAuthChallenge(req, res)
            return
        }
    }

    // No API key, no Clerk. Tools will return the noAuthMessage when called.
    req.authSource = { kind: 'none' }
    next()
}

// ============================================================================
// Public URL normalization middleware
//
// When MCP_PUBLIC_URL is set (deployed environments behind proxies that
// rewrite Host to an internal hostname), we force Express to believe the
// request arrived at the public URL. This is necessary because
// @clerk/mcp-tools composes its WWW-Authenticate header's resource_metadata
// URL, and the /.well-known/oauth-protected-resource response body, from
// req.headers.host + req.protocol. No amount of `trust proxy` helps if the
// proxy doesn't forward X-Forwarded-Host (fly.io's default).
//
// By overriding req.headers.host and setting x-forwarded-proto = https, all
// downstream code (including Clerk's URL composition) sees the public URL.
// The request body, query, method, and auth semantics are unchanged.
// ============================================================================

function publicUrlOverride(req: express.Request, _res: express.Response, next: express.NextFunction) {
    if (!MCP_PUBLIC_URL) return next()
    try {
        const parsed = new URL(MCP_PUBLIC_URL)
        req.headers.host = parsed.host
        req.headers['x-forwarded-host'] = parsed.host
        req.headers['x-forwarded-proto'] = parsed.protocol.replace(':', '')
    } catch {
        // MCP_PUBLIC_URL malformed — log once at boot and fall through.
    }
    next()
}

// Clerk's request middleware runs before authRouter because mcpAuthClerk relies
// on the auth state it installs on req. Treat it as an untrusted-input boundary:
// malformed JWT-shaped Bearer tokens can throw while Clerk decodes them, before
// authRouter's own guards or error handling get a chance to run. Convert those
// failures into the same 401 OAuth challenge as every other invalid credential
// instead of letting Express's default handler expose a stack trace in an HTML
// 500 response.
//
// AgentMail API keys must bypass Clerk entirely. Reusing extractApiKey here and
// in authRouter keeps both layers' routing decisions identical.
const clerkRequestMiddleware = CLERK_ENABLED ? clerkMiddleware() : undefined

const clerkAuthBoundary: express.RequestHandler = (req, res, next) => {
    if (!clerkRequestMiddleware || extractApiKey(req)) return next()

    return clerkRequestMiddleware(req, res, (error?: unknown) => {
        if (!error) return next()

        const errorName = error instanceof Error ? error.name : 'UnknownError'
        console.warn(`[auth] Clerk request authentication failed (${errorName}), returning 401`)
        if (!res.headersSent) return sendOAuthChallenge(req, res)
        next(error)
    })
}

// ============================================================================
// Express app
// ============================================================================

export const app = express()

// Trust the reverse proxy in front of us (Manufact/Cloudflare/fly.io).
// With this, Express respects X-Forwarded-Proto / X-Forwarded-Host when
// those headers are present. For environments where the proxy doesn't
// forward Host reliably (fly.io preview), the publicUrlOverride middleware
// below provides a stronger fallback using the MCP_PUBLIC_URL env var.
app.set('trust proxy', true)

// Normalize req.headers.host to MCP_PUBLIC_URL if set. Must run BEFORE cors
// and the Clerk auth boundary so downstream auth sees the normalized URL.
app.use(publicUrlOverride)

app.use(cors({ exposedHeaders: ['WWW-Authenticate'] }))

// Match the AgentMail API's inbound ceiling exactly. The API runs on API
// Gateway v2 (HTTP API), whose max request body is a hard, non-configurable
// 10 MB (agentmail-api infra/core/gateway.ts uses apigatewayv2.Api with no
// payload override). Attachments are base64 in the JSON body, so this is the
// real send ceiling. We mirror it: express.json's 100kb default 413-rejects
// large tool calls before they reach the MCP handler; anything above 10 MB is
// rejected downstream by API Gateway regardless, so matching is correct.
const MAX_REQUEST_BODY = '10mb'
const parseJsonBody = express.json({ limit: MAX_REQUEST_BODY })

// clerkAuthBoundary and body parsing are deliberately NOT app.use'd. As globals
// they ran before the MCP routes, so a request paid Clerk authentication and up
// to 10 MB of JSON parsing BEFORE admission control could see it — which is
// exactly the cost a shed is supposed to avoid, and exactly the cost that
// accumulates without bound during the retry storm this guards against. Both are
// mounted inside the MCP pipeline below, after the admission gate.
//
// Nothing else needs them: /health and the openai-apps challenge read no body
// and no auth, and the OAuth metadata handlers compose their response from the
// publishable key and the request URL alone.

// OpenAI app ownership verification. This token is public by design and must
// be returned verbatim from the origin-root well-known URL.
app.get('/.well-known/openai-apps-challenge', (_req, res) => {
    res.type('text/plain').send(OPENAI_APPS_CHALLENGE_TOKEN)
})

// Reject non-POST MCP methods before auth and before any per-request
// allocation. This server is stateless (sessionIdGenerator: undefined) and
// never initiates messages, so a standalone GET SSE stream can never carry an
// event — yet the SDK transport accepts the GET and holds the stream open
// indefinitely, pinning the whole per-request graph (a fresh McpServer with
// every registered tool, the transport, req/res) until the client goes away.
// That is what turned the 2026-07-21 reconnect storm (~962 SSE connects in
// 54s, 326 in one 5s window) into heap exhaustion at the ~495 MB V8 limit.
//
// The Streamable HTTP spec explicitly allows a server that offers no SSE
// stream to answer GET with 405 Method Not Allowed; clients then proceed
// without a notification stream, which for this server changes nothing.
// DELETE (session termination) is likewise meaningless with no sessions.
// Mounted before authRouter so a storm of GETs is shed without spending a
// Clerk token verification on each one; body shape matches the SDK's own
// 405 (jsonrpc error -32000).
const statelessMethodGuard: express.RequestHandler = (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'DELETE') return next()
    res.status(405)
        .set('Allow', 'POST')
        .json({
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Method Not Allowed: stateless server, POST only' },
            id: null,
        })
}

// ============================================================================
// Admission control
//
// Every in-flight POST pins a whole per-request graph: a fresh McpServer with
// all tools registered, a transport, and req/res. That is cheap in isolation
// (~0.3 ms to build) and the box sustains hundreds of requests per second while
// concurrency stays bounded. It stops being cheap when concurrency does not.
//
// The 2026-08-19 outage was that unbounded case. A latency blip pushed clients
// into timeout-and-retry, retries raised concurrency, concurrency raised the
// live set and GC cost, and the slower process produced more timeouts — a loop
// that sustains itself at flat demand. Throughput fell from ~200 req/s to under
// 10 while p50 passed 9 s, and it never recovered: redeploying onto a fresh
// machine bought eight minutes before the retry backlog rebuilt the queue.
// Capacity was never the limit — an idle machine on the same image serves 268
// req/s against a 30-60 req/s demand — the missing piece was a ceiling.
//
// So we cap concurrency and shed the excess INSTANTLY. A fast 503 is strictly
// better than a slow 200 here: it costs no per-request graph, it keeps the queue
// short enough that admitted requests stay fast, and Retry-After pushes clients
// into backoff instead of the tighter retry loop that a timeout provokes.
// Shedding is what makes the feedback loop stop sustaining itself.
//
// Mounted after statelessMethodGuard (shed GETs must not consume a slot) and
// before authRouter (a shed request must not cost a Clerk verification).
// ============================================================================

const MAX_IN_FLIGHT = Math.max(1, parseInt(process.env.AGENTMAIL_MAX_IN_FLIGHT || '', 10) || 256)
const SHED_RETRY_AFTER_SECONDS = Math.max(
    1,
    parseInt(process.env.AGENTMAIL_SHED_RETRY_AFTER_SECONDS || '', 10) || 2
)

// Event loop lag is the signal that actually matches the observed failure, and
// an in-flight counter alone would have missed it. When the loop is saturated a
// request waits in the kernel and libuv queues LONG before Express routes it,
// so by the time any middleware could increment a counter most of the latency
// has already been spent — in-flight reads near zero while p50 is 9 s.
// Measuring the loop catches the backlog wherever it sits, which is why this is
// the primary trigger and the in-flight cap is only a secondary bound.
//
// Healthy lag here is single-digit to tens of milliseconds, so a mean of half a
// second means the process is already deep in the queue-growth spiral.
const MAX_EVENT_LOOP_LAG_MS = Math.max(
    50,
    parseInt(process.env.AGENTMAIL_MAX_EVENT_LOOP_LAG_MS || '', 10) || 500
)
const LAG_SAMPLE_INTERVAL_MS = 1000

const loopDelay = monitorEventLoopDelay({ resolution: 20 })
loopDelay.enable()
let recentLagMs = 0
// Mean over the window, not max: a single GC pause spikes max and would shed
// traffic on a perfectly healthy server. Sustained saturation is what we react
// to, and that is what shows up in the mean.
setInterval(() => {
    recentLagMs = loopDelay.mean / 1e6
    loopDelay.reset()
}, LAG_SAMPLE_INTERVAL_MS).unref()

// ============================================================================
// Socket & descriptor telemetry
//
// The 2026-08-20 follow-up showed the queue is NOT inside Node. On the
// production machine a GET /mcp — answered 405 by the FIRST handler in the
// pipeline, before admission, parsing, or auth — took 10-12 s, while event loop
// lag sat at 20 ms and 0-2 requests were in flight; the idle sibling on the same
// image answered in 0.13 s. So the wait is between the proxy handing us a
// connection and our first line of code running. Two things can fill that gap,
// and only one of them is ours to fix:
//
//   - Node cannot accept. When open descriptors hit the ulimit, accept() fails
//     with EMFILE; libuv then accepts-and-closes to drain the backlog, the proxy
//     sees resets and retries, and every request waits while the loop stays
//     idle. open_fds approaching max_fds is the tell, and the fix is ours:
//     hold fewer connections (keep-alive and header timeouts, maxConnections).
//   - The proxy is queueing before it connects. Then connections and fds stay
//     low here while latency climbs, and the lever is proxy concurrency and
//     horizontal scale — not anything in this process.
//
// /health reports both so the next episode answers this in one request.
// ============================================================================

let openConnections = 0
let acceptedTotal = 0
let clientErrorsTotal = 0

function readOpenFds(): number | undefined {
    try {
        return fs.readdirSync('/proc/self/fd').length
    } catch {
        return undefined
    }
}

function readMaxFds(): number | 'unlimited' | undefined {
    try {
        // "Max open files            1024                 1048576              files"
        const line = fs
            .readFileSync('/proc/self/limits', 'utf8')
            .split('\n')
            .find((l) => l.startsWith('Max open files'))
        const m = line?.match(/Max open files\s+(\d+|unlimited)/)
        if (!m) return undefined
        return m[1] === 'unlimited' ? 'unlimited' : parseInt(m[1]!, 10)
    } catch {
        return undefined
    }
}

// The SOFT limit is what accept() enforces.
const MAX_FDS = readMaxFds()
// Transition-logged, same as shedding: at exhaustion every accept fails.
let fdPressure = false
function sampleDescriptors() {
    const open = readOpenFds()
    if (open === undefined || typeof MAX_FDS !== 'number') return
    const pressured = open > MAX_FDS * 0.8
    if (pressured && !fdPressure) {
        fdPressure = true
        console.warn(`[fds] pressure: ${open} open of ${MAX_FDS} (soft limit), ${openConnections} connections`)
    } else if (!pressured && fdPressure) {
        fdPressure = false
        console.warn(`[fds] recovered: ${open} open of ${MAX_FDS}`)
    }
}

// ============================================================================
// Kernel TCP telemetry
//
// With #44 deployed the picture sharpened: at the moment latency rose, the
// accept rate fell from ~95/s to ~45/s while open_fds sat at 30 of 10240,
// open_connections at 4-7, and the loop stayed near idle. Node is not failing
// to accept; fewer connections are reaching accept(). That narrows the gap to
// two layers: the proxy, and this VM's own kernel. The kernel is the last layer
// we have not looked at and the last one that is ours to tune, so expose what it
// knows. Everything below is read from /proc, needs no privileges, and costs
// microseconds.
//
//   listen.accept_queue   connections accepted by the kernel, not yet by Node.
//                         High here with an idle loop would be the one case
//                         where the stall IS in this process.
//   sockets.time_wait     who actively closes. ~rate*60s here means we do and
//                         the TIME_WAIT cost is on our side of the link.
//   tcp_ext.*             ListenOverflows / ListenDrops = accept backlog full;
//                         PAWSPassive = SYNs refused on a recycled 4-tuple;
//                         TCPTimeWaitOverflow = tw bucket table full.
//   requests.connection_header  whether the proxy asks for close or keep-alive,
//                         which decides whether reuse is even on the table.
// ============================================================================

function readProc(path: string): string | undefined {
    try {
        return fs.readFileSync(path, 'utf8')
    } catch {
        return undefined
    }
}

/** "Tcp: A B C\nTcp: 1 2 3" style tables in /proc/net/snmp and /proc/net/netstat. */
function readProcTable(path: string, prefix: string, keys: readonly string[]): Record<string, number> | null {
    const text = readProc(path)
    if (!text) return null
    const lines = text.split('\n').filter((l) => l.startsWith(prefix + ':'))
    if (lines.length < 2) return null
    const names = lines[0]!.split(/\s+/).slice(1)
    const values = lines[1]!.split(/\s+/).slice(1)
    const out: Record<string, number> = {}
    for (const k of keys) {
        const i = names.indexOf(k)
        if (i !== -1) out[k] = Number(values[i])
    }
    return out
}

const TCP_STATES: Record<string, string> = {
    '01': 'established',
    '02': 'syn_sent',
    '03': 'syn_recv',
    '04': 'fin_wait1',
    '05': 'fin_wait2',
    '06': 'time_wait',
    '07': 'close',
    '08': 'close_wait',
    '09': 'last_ack',
    '0A': 'listen',
    '0B': 'closing',
}

/** Per-state socket counts on our port, plus the listen socket's accept queue. */
function readPortSockets(port: number) {
    const hexPort = port.toString(16).toUpperCase().padStart(4, '0')
    const states: Record<string, number> = {}
    let acceptQueue: number | null = null
    let backlogMax: number | null = null
    for (const path of ['/proc/net/tcp', '/proc/net/tcp6']) {
        const text = readProc(path)
        if (!text) continue
        for (const line of text.split('\n').slice(1)) {
            const cols = line.trim().split(/\s+/)
            if (cols.length < 5) continue
            const local = cols[1]!
            if (!local.endsWith(':' + hexPort)) continue
            const st = cols[3]!
            const name = TCP_STATES[st] ?? st
            states[name] = (states[name] ?? 0) + 1
            if (st === '0A') {
                // For LISTEN sockets the kernel reports rx_queue = current
                // accept-queue depth and tx_queue = configured backlog.
                const [tx, rx] = cols[4]!.split(':')
                acceptQueue = parseInt(rx!, 16)
                backlogMax = parseInt(tx!, 16)
            }
        }
    }
    return { states, acceptQueue, backlogMax }
}

function readSysctl(name: string): number | null {
    const v = readProc('/proc/sys/' + name)
    return v ? Number(v.trim()) : null
}

// Fixed for the life of the VM — read once, reported for context.
const KERNEL = {
    somaxconn: readSysctl('net/core/somaxconn'),
    tcp_max_tw_buckets: readSysctl('net/ipv4/tcp_max_tw_buckets'),
    tcp_fin_timeout: readSysctl('net/ipv4/tcp_fin_timeout'),
    tcp_tw_reuse: readSysctl('net/ipv4/tcp_tw_reuse'),
    tcp_timestamps: readSysctl('net/ipv4/tcp_timestamps'),
    ip_local_port_range: readProc('/proc/sys/net/ipv4/ip_local_port_range')?.trim().replace(/\s+/, '-') ?? null,
}

const TCP_EXT_KEYS = [
    'ListenOverflows',
    'ListenDrops',
    'TCPBacklogDrop',
    'TCPReqQFullDrop',
    'TCPReqQFullDoCookies',
    'TCPTimeWaitOverflow',
    'TW',
    'TWRecycled',
    'TWKilled',
    'PAWSPassive',
    'PAWSEstab',
    'TCPAbortOnClose',
    'TCPAbortOnTimeout',
    'TCPTimeouts',
    'EmbryonicRsts',
    'TCPSynRetrans',
] as const
const TCP_SNMP_KEYS = ['ActiveOpens', 'PassiveOpens', 'AttemptFails', 'EstabResets', 'CurrEstab', 'RetransSegs', 'InErrs', 'OutRsts'] as const

// What the proxy asks for on each request. Sampled on every request, so it is
// a running histogram rather than a one-shot.
const connectionHeaderSeen: Record<string, number> = {}
const httpVersionSeen: Record<string, number> = {}

// The one counter that made the outage legible: ListenOverflows is the kernel
// dropping a completed handshake because the accept backlog was full. It is
// silent — nothing in Node or the proxy logs it — so alert on any increase.
// Log the transition into and out of overflow, not each drop, and report the
// total dropped since it started so a burst is visible even after it clears.
let listenOverflowBase: number | null = null
let lastOverflow = 0
let overflowing = false
function sampleAcceptQueue() {
    const ext = readProcTable('/proc/net/netstat', 'TcpExt', TCP_EXT_KEYS)
    const overflows = ext?.ListenOverflows
    if (overflows === undefined) return
    if (listenOverflowBase === null) {
        listenOverflowBase = overflows
        lastOverflow = overflows
        return
    }
    const dropped = overflows - lastOverflow
    lastOverflow = overflows
    if (dropped > 0 && !overflowing) {
        overflowing = true
        console.warn(
            `[accept] backlog overflow: kernel dropped ${dropped} handshake(s) this interval ` +
                `(${overflows - listenOverflowBase} since start, backlog ${LISTEN_BACKLOG}). ` +
                `Connections are arriving faster than the event loop drains accept().`
        )
    } else if (dropped === 0 && overflowing) {
        overflowing = false
        console.warn(`[accept] backlog recovered (${overflows - listenOverflowBase} dropped total)`)
    }
}

function kernelTcpSnapshot() {
    const sockstat = readProc('/proc/net/sockstat')
    const tcpLine = sockstat?.split('\n').find((l) => l.startsWith('TCP:'))
    const m = tcpLine?.match(/inuse (\d+) orphan (\d+) tw (\d+) alloc (\d+)/)
    return {
        sockstat: m ? { inuse: +m[1]!, orphan: +m[2]!, time_wait: +m[3]!, alloc: +m[4]! } : null,
        port: readPortSockets(PORT),
        tcp: readProcTable('/proc/net/snmp', 'Tcp', TCP_SNMP_KEYS),
        tcp_ext: readProcTable('/proc/net/netstat', 'TcpExt', TCP_EXT_KEYS),
        kernel: KERNEL,
        connection_header: connectionHeaderSeen,
        http_version: httpVersionSeen,
    }
}

/**
 * One admitted request's hold on the in-flight cap. `ownedByHandler` transfers
 * responsibility for releasing it from the connection lifecycle to mcpHandler,
 * so a client that walks away cannot free capacity that is still in use.
 */
type AdmissionSlot = { release: () => void; ownedByHandler: boolean }

function admissionSlotOf(res: express.Response): AdmissionSlot | undefined {
    return res.locals.admissionSlot as AdmissionSlot | undefined
}

let inFlight = 0
let shedTotal = 0
// Log the transition, not the event: at overload the shed rate is exactly the
// excess arrival rate, so per-request logging would itself become a load source.
let shedding = false

function overloadReason(): string | undefined {
    if (recentLagMs > MAX_EVENT_LOOP_LAG_MS) {
        return `event loop ${Math.round(recentLagMs)} ms behind (limit ${MAX_EVENT_LOOP_LAG_MS} ms)`
    }
    if (inFlight >= MAX_IN_FLIGHT) {
        return `${inFlight} in flight at or above cap ${MAX_IN_FLIGHT}`
    }
    return undefined
}

export const admissionControl: express.RequestHandler = (req, res, next) => {
    const reason = overloadReason()
    if (reason) {
        shedTotal++
        if (!shedding) {
            shedding = true
            console.warn(`[admission] shedding: ${reason}`)
        }
        res.status(503)
            .set('Retry-After', String(SHED_RETRY_AFTER_SECONDS))
            .json({
                jsonrpc: '2.0',
                error: { code: -32000, message: 'Server overloaded, retry shortly' },
                id: null,
            })
        return
    }

    // Guard against a double release: Express can emit 'close' after 'finish',
    // and releasing twice would let in-flight drift below zero, silently
    // raising the effective cap.
    let released = false
    const slot: AdmissionSlot = {
        ownedByHandler: false,
        release: () => {
            if (released) return
            released = true
            inFlight--
            if (shedding && !overloadReason()) {
                shedding = false
                console.warn(
                    `[admission] recovered: ${inFlight} in flight, ` +
                        `${Math.round(recentLagMs)} ms loop lag, ${shedTotal} shed so far`
                )
            }
        },
    }
    res.locals.admissionSlot = slot

    // A client abort must NOT free the slot while the handler is still working.
    // transport.close() only aborts the MCP-level signal; agentmail-toolkit
    // ignores extra.signal, so the AgentMail HTTP request it started keeps
    // running. Releasing on abort would let a timed-out client immediately retry
    // into a fresh slot and stack a second live upstream call behind a cap that
    // reads healthy — rebuilding exactly the unbounded background concurrency
    // this is meant to bound.
    //
    // So 'close' only releases for requests that never reached mcpHandler (405,
    // a 401 from authRouter, a body-parse failure). Once the handler takes
    // ownership it releases in its own finally, and requestTimeout is the
    // backstop for work that never settles at all.
    res.on('close', () => {
        if (!slot.ownedByHandler) slot.release()
    })

    // Counted last, once the release path is fully wired. Incrementing earlier
    // means anything that throws in between leaks a slot permanently, and enough
    // leaks silently pin the server in shedding with nothing actually running.
    inFlight++
    next()
}

// A slot is only useful if it comes back. Two paths hold one open indefinitely:
// a client that stops reading without resetting the connection, and the
// contained-unhandled-rejection path above, where the request deliberately gets
// no response. Without a ceiling those accumulate until the cap holds only dead
// requests and every live one is shed — turning a slow outage into a total one.
//
// Ending the response makes 'close' fire, which releases the slot and runs the
// same transport teardown as a client abort, reusing an already-exercised path.
const REQUEST_TIMEOUT_MS = Math.max(
    1000,
    parseInt(process.env.AGENTMAIL_REQUEST_TIMEOUT_MS || '', 10) || 30_000
)

export const requestTimeout: express.RequestHandler = (req, res, next) => {
    const timer = setTimeout(() => {
        if (!res.headersSent) {
            console.warn(`[timeout] request exceeded ${REQUEST_TIMEOUT_MS} ms, returning 504`)
            res.status(504).json({
                jsonrpc: '2.0',
                error: { code: -32000, message: 'Request timed out' },
                id: null,
            })
            return
        }

        // Headers are already out, so there is no status left to send — and
        // returning here would make this timer a no-op for exactly the requests
        // that need it most. StreamableHTTPServerTransport writes SSE headers
        // before a tools/call handler settles, so every hung tool call lands in
        // this branch: 'close' never fires on its own, the slot never comes
        // back, and MAX_IN_FLIGHT hung calls would leave the server shedding
        // permanently. Destroy the stream to force the connection down, and
        // release explicitly rather than relying on teardown ordering.
        console.warn(
            `[timeout] streamed request exceeded ${REQUEST_TIMEOUT_MS} ms, destroying connection`
        )
        res.destroy()
        admissionSlotOf(res)?.release()
    }, REQUEST_TIMEOUT_MS)
    // unref so a pending timer never holds the process open during shutdown.
    timer.unref()
    res.on('close', () => clearTimeout(timer))
    next()
}

// MCP request handler. We don't use streamableHttpHandler here because it
// pre-binds an MCP server; we want to construct ours per-request based on
// the resolved auth source. Only POST reaches this handler: text/html GETs
// are redirected to the docs above, all other GETs and DELETEs get a 405
// from statelessMethodGuard.
const mcpHandler: express.RequestHandler = async (req, res) => {
    // Take the slot off the connection lifecycle: from here the request is only
    // done when this handler settles, not when the client stops listening.
    const slot = admissionSlotOf(res)
    if (slot) slot.ownedByHandler = true
    try {
        const authSource = req.authSource ?? { kind: 'none' }
        const server = createMcpServer(authSource)
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
        res.on('close', () => transport.close())
        await server.connect(transport)
        await transport.handleRequest(req, res, req.body)
    } catch (error) {
        console.error('[mcp] request error:', error)
        if (!res.headersSent) {
            res.status(500).json({
                jsonrpc: '2.0',
                error: { code: -32603, message: 'Internal server error' },
                id: null,
            })
        }
    } finally {
        // Settled either way, so the capacity is genuinely free now.
        slot?.release()
    }
}

// Human navigation goes to the docs before authentication. MCP requests stay
// on the same origin so credentials are never redirected across origins.
app.get(['/', '/mcp'], (req, res, next) => {
    if (!req.headers.accept?.includes('text/html')) return next()
    res.redirect(302, DOCS_URL)
})

// MCP endpoints, ordered cheapest-first so an overloaded server spends as little
// as possible on a request it is about to reject: statelessMethodGuard sheds
// GET/DELETE, admissionControl caps concurrency, requestTimeout guarantees slots
// come back, and only then does a request earn body parsing, Clerk
// authentication, and a per-request MCP server.
const mcpPipeline = [
    statelessMethodGuard,
    admissionControl,
    requestTimeout,
    parseJsonBody,
    clerkAuthBoundary,
    authRouter,
    mcpHandler,
]
app.all('/mcp', ...mcpPipeline)
app.all('/', ...mcpPipeline)

// OAuth discovery metadata endpoints. Only mounted when Clerk is configured.
if (CLERK_ENABLED) {
    // Advertise the identity scopes supported by Clerk. `openid` is required
    // by ChatGPT's OAuth client. Some DCR clients omit `scope` when registering,
    // so Clerk's instance-level DCR defaults must also include openid, email,
    // and profile; otherwise the later authorization request fails with
    // invalid_scope. Verify the Clerk setting with `pnpm check:oauth-config`.
    //
    // We deliberately do NOT advertise `user:org:read`: dynamically registered
    // clients are not granted it by default, so advertising it caused clients
    // (Cursor, Codex, etc.) to request a scope that Clerk rejected at consent —
    // broken OAuth onboarding since 2026-05-08.
    //
    // Multi-org users no longer need the Clerk consent-screen org picker (which
    // required user:org:read): they pick their org in-session via the
    // `select_organization` MCP tool, which works for every client. See
    // buildClientFromClerkUser path 3/4. (An earlier fix tried advertising the
    // scope only to Claude via User-Agent; dropped because Claude's real
    // discovery UA — python-httpx / empty / Chrome — isn't distinguishable.)
    const protectedResourceHandler = protectedResourceHandlerClerk({
        scopes_supported: ['openid', 'email', 'profile'],
    })
    app.get('/.well-known/oauth-protected-resource/mcp', protectedResourceHandler)
    app.get('/.well-known/oauth-protected-resource', protectedResourceHandler)
    app.get('/.well-known/oauth-authorization-server', authServerMetadataHandlerClerk)
}

app.get('/health', (_req, res) => {
    const { heapUsed, rss } = process.memoryUsage()
    res.json({
        status: 'ok',
        clerk_enabled: CLERK_ENABLED,
        agentmail_api_url: AGENTMAIL_API_URL ?? '(SDK default)',
        mcp_public_url: MCP_PUBLIC_URL ?? '(not set, using Host header)',
        build_sha: process.env.BUILD_SHA ?? 'unknown',
        heap: {
            used_mb: Math.round(heapUsed / MB),
            limit_mb: Math.round(HEAP_LIMIT_BYTES / MB),
            rss_mb: Math.round(rss / MB),
        },
        // Concurrency, not memory, is what fails on this server. The Aug 19
        // outage ran at a healthy 74-92 MB heap the whole time, so the heap
        // block above stayed green while the queue was thousands deep. These
        // are the leading indicators: event_loop_lag_ms approaching the limit
        // is the collapse starting, a climbing shed_total is it in progress.
        requests: {
            in_flight: inFlight,
            max_in_flight: MAX_IN_FLIGHT,
            shed_total: shedTotal,
            event_loop_lag_ms: Math.round(recentLagMs),
            max_event_loop_lag_ms: MAX_EVENT_LOOP_LAG_MS,
        },
        // Where the queue is. Low in_flight + low lag + climbing latency means
        // the wait is upstream of the first middleware. If open_fds is near
        // max_fds the process cannot accept and the fix is ours; if both are
        // low the proxy is queueing before it connects and the fix is not.
        sockets: {
            open_connections: openConnections,
            accepted_total: acceptedTotal,
            client_errors_total: clientErrorsTotal,
            open_fds: readOpenFds() ?? null,
            max_fds: MAX_FDS ?? null,
        },
        tcp: kernelTcpSnapshot(),
    })
})

// ============================================================================
// Heap pressure telemetry
//
// The 2026-07-21 crash aborted at ~467 MB retained after full GC against a
// ~495 MB V8 heap limit, with no warning beforehand. This monitor gives the
// gateway logs a leading indicator and (opt-in) a heap snapshot captured
// while there is still headroom to analyze it.
//
//   - Every 30s, if heap used exceeds AGENTMAIL_HEAP_WARN_MB (default 350,
//     capped at 75% of the actual V8 limit so small dev heaps still warn
//     before dying), log used/limit/rss.
//   - If AGENTMAIL_HEAP_SNAPSHOT=1, additionally write ONE heap snapshot per
//     process lifetime the first time the threshold is crossed. Opt-in and
//     one-shot because v8.writeHeapSnapshot blocks the event loop and
//     temporarily needs about as much memory as the heap it captures — the
//     threshold sits well below the limit precisely so the capture can
//     succeed. The .heapsnapshot lands in the working directory (or
//     AGENTMAIL_HEAP_SNAPSHOT_DIR) for Chrome DevTools.
//
// unref() so the timer never keeps a test process (or a draining worker)
// alive.
// ============================================================================

const MB = 1024 * 1024
const HEAP_LIMIT_BYTES = v8.getHeapStatistics().heap_size_limit
const HEAP_WARN_BYTES = Math.min(
    (parseInt(process.env.AGENTMAIL_HEAP_WARN_MB || '', 10) || 350) * MB,
    HEAP_LIMIT_BYTES * 0.75
)
let heapSnapshotWritten = false

setInterval(() => {
    const { heapUsed, rss } = process.memoryUsage()
    if (heapUsed < HEAP_WARN_BYTES) return
    console.warn(
        `[heap] pressure: used ${Math.round(heapUsed / MB)} MB of ${Math.round(
            HEAP_LIMIT_BYTES / MB
        )} MB limit (rss ${Math.round(rss / MB)} MB, warn threshold ${Math.round(HEAP_WARN_BYTES / MB)} MB)`
    )
    if (!heapSnapshotWritten && process.env.AGENTMAIL_HEAP_SNAPSHOT === '1') {
        heapSnapshotWritten = true
        try {
            const dir = process.env.AGENTMAIL_HEAP_SNAPSHOT_DIR
            const file = v8.writeHeapSnapshot(
                dir ? `${dir.replace(/\/$/, '')}/agentmail-mcp-${Date.now()}.heapsnapshot` : undefined
            )
            console.warn(`[heap] snapshot written to ${file}`)
        } catch (error) {
            console.error('[heap] snapshot failed:', error)
        }
    }
}, 30_000).unref()

// ============================================================================
// Env var diagnostic (prints on boot to help debug Manufact injection issues).
// We never print full secret values — only presence + length + prefix when
// safe — so this is OK to leave in production.
// ============================================================================

function maskEnvVar(name: string): string {
    const val = process.env[name]
    if (!val) return `${name}: <missing>`
    // Safe prefix for keys that have a documented public prefix (pk_, sk_, am_).
    // For everything else we just report length.
    const firstChars = val.slice(0, 7)
    const safePrefix = /^(pk_|sk_|am_)/.test(firstChars) ? firstChars : '***'
    return `${name}: present (len=${val.length}, prefix=${safePrefix})`
}

// Last-resort containment. Node's default for an unhandled promise rejection
// is to exit(1), which takes down every live SSE connection on the box and
// triggers a client reconnect storm against the replacement process. The known
// producer (bare-Bearer throw detached inside @clerk/mcp-tools — see
// authRouter) is guarded above, but any future detached rejection should be
// logged loudly and survived, not turn into a crash loop. The request that
// caused it gets no response and times out client-side; that is strictly
// better than dropping everyone.
process.on('unhandledRejection', (reason) => {
    console.error('[fatal-contained] unhandled promise rejection:', reason)
})

if (process.env.AGENTMAIL_MCP_NO_LISTEN !== '1') {
    // Options form so backlog is honored: @types/express omits the
    // (port, backlog, callback) overload, but Express forwards an options
    // object straight to http.Server.listen, which does accept { backlog }.
    const server = app.listen({ port: PORT, backlog: LISTEN_BACKLOG }, () => {
    console.log(`AgentMail MCP server running on port ${PORT}`)
    console.log(`MCP endpoints: http://localhost:${PORT}/ and http://localhost:${PORT}/mcp`)
    console.log(`Clerk OAuth: ${CLERK_ENABLED ? 'enabled' : 'disabled (no CLERK_* env vars)'}`)
    console.log(`AgentMail API: ${AGENTMAIL_API_URL ?? '(SDK default)'}`)
    console.log(`Public URL override: ${MCP_PUBLIC_URL ?? '(not set, using Host header)'}`)
    console.log('--- env var diagnostic ---')
    console.log(maskEnvVar('CLERK_PUBLISHABLE_KEY'))
    console.log(maskEnvVar('CLERK_SECRET_KEY'))
    console.log(maskEnvVar('CONSOLE_JWT_PRIVATE_KEY'))
    console.log(maskEnvVar('AGENTMAIL_API_URL'))
    console.log(maskEnvVar('AGENTMAIL_API_KEY'))
    console.log(maskEnvVar('MCP_PUBLIC_URL'))
    console.log(`Max open files (soft): ${MAX_FDS ?? 'unknown'}`)
    console.log(`Listen backlog: ${LISTEN_BACKLOG} (kernel somaxconn ${KERNEL.somaxconn ?? 'unknown'})`)
    console.log(`Kernel TCP: ${JSON.stringify(KERNEL)}`)
    console.log('--------------------------')
    })

    server.on('connection', () => {
        acceptedTotal++
    })
    server.on('request', (req) => {
        const c = (req.headers.connection ?? '(none)').toLowerCase()
        connectionHeaderSeen[c] = (connectionHeaderSeen[c] ?? 0) + 1
        httpVersionSeen[req.httpVersion] = (httpVersionSeen[req.httpVersion] ?? 0) + 1
    })
    // Parse errors and socket-level timeouts surface here, not in Express. A
    // climbing count means sockets are being torn down abnormally.
    server.on('clientError', () => {
        clientErrorsTotal++
    })
    setInterval(() => {
        server.getConnections((err, count) => {
            if (!err) openConnections = count
        })
        sampleDescriptors()
        sampleAcceptQueue()
    }, 1000).unref()
}
