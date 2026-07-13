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
import { z } from 'zod'

// ============================================================================
// Config
// ============================================================================

const PORT = parseInt(process.env.PORT || '3000', 10)
const DOCS_URL = 'https://docs.agentmail.to/integrations/mcp'
const OPENAI_APPS_CHALLENGE_TOKEN = 'x5q5TTetk6mOB_sFlNKxXnvES1T8slSZXyWOL-T2b1s'

// Where the AgentMail backend lives. Manufact env var should set this per
// deployment (staging vs prod). The previous behavior was an unset URL =
// SDK default; we keep that as the fallback.
const AGENTMAIL_API_URL = process.env.AGENTMAIL_API_URL
const AGENTMAIL_WS_URL = AGENTMAIL_API_URL?.replace('https://api.', 'wss://ws.')

const CLERK_ENABLED = Boolean(process.env.CLERK_PUBLISHABLE_KEY && process.env.CLERK_SECRET_KEY)

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

/**
 * Resolve AgentMail internal org id from a Clerk org id.
 * Mirrors console/app/lib/agentmail-jwt.server.ts getInternalOrganizationId.
 */
async function getInternalOrganizationId(clerkOrgId: string): Promise<string> {
    const bootstrapJwt = await signConsoleJwt(clerkOrgId)
    const apiUrl = AGENTMAIL_API_URL
    if (!apiUrl) {
        throw new Error('AGENTMAIL_API_URL env var is required to use OAuth path')
    }

    const response = await fetch(`${apiUrl}/v0/auth/internal-org`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${bootstrapJwt}` },
    })

    if (!response.ok) {
        const body = await response.text()
        throw new Error(`/v0/auth/internal-org failed: ${response.status} ${body}`)
    }

    const data = (await response.json()) as { organization_id?: string }
    if (!data.organization_id) {
        throw new Error('No organization_id in /v0/auth/internal-org response')
    }
    return data.organization_id
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
 * This makes multi-org work for every client (Claude/Cursor/Codex) without
 * depending on the Clerk consent-screen org picker or per-client UA hacks.
 */
async function buildClientFromClerkUser(
    clerkUserId: string,
    selectedClerkOrgId?: string
): Promise<AgentMailClient> {
    const memberships = await clerkClient.users.getOrganizationMembershipList({
        userId: clerkUserId,
    })
    if (!memberships.data || memberships.data.length === 0) {
        throw new Error(
            `User ${clerkUserId} has no Clerk organization memberships. ` +
                `Every AgentMail user is expected to belong to at least one org.`
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
    })
}

/**
 * Build an AgentMailClient from a raw API key (legacy path).
 */
function buildClientFromApiKey(apiKey: string): AgentMailClient {
    return new AgentMailClient({
        environment: AGENTMAIL_API_URL
            ? { http: AGENTMAIL_API_URL, websockets: AGENTMAIL_WS_URL || '' }
            : undefined,
        apiKey,
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

export function createMcpServer(auth: AuthSource): McpServer {
    const server = new McpServer({ name: 'AgentMail', version: '1.0.0' })

    // Build a placeholder client just so the toolkit can enumerate tools.
    // We swap in a real client per tool call below.
    const placeholderClient = new AgentMailClient({ apiKey: 'placeholder' })
    const toolkit = new AgentMailToolkit(placeholderClient)

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
    }

    for (const tool of toolkit.getTools()) {
        server.registerTool(tool.name, tool, async (args, extra) => {
            try {
                let client: AgentMailClient
                if (auth.kind === 'clerk') {
                    client = await buildClientFromClerkUser(auth.clerkUserId, auth.clerkOrgId)
                } else if (auth.kind === 'apiKey') {
                    client = buildClientFromApiKey(auth.apiKey)
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
                    const selected = await getStoredMcpOrgId(auth.clerkUserId)
                    const organizations = (memberships.data ?? []).map((m) => ({
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
                    'persists across sessions until you change it. OAuth sessions only -- API-key ' +
                    'requests return an error explaining that organization selection does not ' +
                    'apply to API-key authentication.',
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
                    await setStoredMcpOrgId(auth.clerkUserId, match.organization.id)
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

const authRouter: express.RequestHandler = async (req, res, next) => {
    const apiKey = extractApiKey(req)
    if (apiKey) {
        req.authSource = { kind: 'apiKey', apiKey }
        return next()
    }

    // No API key. If Clerk is configured, hand off to mcpAuthClerk for OAuth.
    if (CLERK_ENABLED) {
        return mcpAuthClerk(req, res, (err) => {
            if (err) return next(err)
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
// and clerkMiddleware so they see the normalized URL.
app.use(publicUrlOverride)

app.use(cors({ exposedHeaders: ['WWW-Authenticate'] }))
if (CLERK_ENABLED) {
    app.use(clerkMiddleware())
}
// Match the AgentMail API's inbound ceiling exactly. The API runs on API
// Gateway v2 (HTTP API), whose max request body is a hard, non-configurable
// 10 MB (agentmail-api infra/core/gateway.ts uses apigatewayv2.Api with no
// payload override). Attachments are base64 in the JSON body, so this is the
// real send ceiling. We mirror it: express.json's 100kb default 413-rejects
// large tool calls before they reach the MCP handler; anything above 10 MB is
// rejected downstream by API Gateway regardless, so matching is correct.
const MAX_REQUEST_BODY = '10mb'
app.use(express.json({ limit: MAX_REQUEST_BODY }))

// OpenAI app ownership verification. This token is public by design and must
// be returned verbatim from the origin-root well-known URL.
app.get('/.well-known/openai-apps-challenge', (_req, res) => {
    res.type('text/plain').send(OPENAI_APPS_CHALLENGE_TOKEN)
})

// MCP request handler. We don't use streamableHttpHandler here because it
// pre-binds an MCP server; we want to construct ours per-request based on
// the resolved auth source.
const mcpHandler: express.RequestHandler = async (req, res) => {
    if (req.method === 'GET' && req.headers.accept?.includes('text/html')) {
        return res.redirect(302, DOCS_URL)
    }

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
    }
}

// Human navigation goes to the docs before authentication. MCP requests stay
// on the same origin so credentials are never redirected across origins.
app.get(['/', '/mcp'], (req, res, next) => {
    if (!req.headers.accept?.includes('text/html')) return next()
    res.redirect(302, DOCS_URL)
})

// MCP endpoints. authRouter runs first to decide OAuth vs API key.
app.all('/mcp', authRouter, mcpHandler)
app.all('/', authRouter, mcpHandler)

// OAuth discovery metadata endpoints. Only mounted when Clerk is configured.
if (CLERK_ENABLED) {
    // Advertise the identity scopes supported by Clerk. `openid` is required
    // by ChatGPT's OAuth client and must be included during DCR so Clerk allows
    // it on the subsequent authorization request. We deliberately do NOT
    // advertise `user:org:read`: Clerk grants dynamically-registered (DCR) clients only
    // `email offline_access profile`, so any DCR client (Cursor, Codex, etc.)
    // that requested the advertised user:org:read was rejected with
    // invalid_scope at consent — broken OAuth onboarding since 2026-05-08.
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
    res.json({
        status: 'ok',
        clerk_enabled: CLERK_ENABLED,
        agentmail_api_url: AGENTMAIL_API_URL ?? '(SDK default)',
        mcp_public_url: MCP_PUBLIC_URL ?? '(not set, using Host header)',
        build_sha: process.env.BUILD_SHA ?? 'unknown',
    })
})

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

if (process.env.AGENTMAIL_MCP_NO_LISTEN !== '1') app.listen(PORT, () => {
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
    console.log('--------------------------')
})
