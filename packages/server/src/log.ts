/**
 * Structured logging: every line is one complete JSON object.
 *
 * Manufact's log API returns the newest ~50K characters of the merged output of
 * every machine, with no timestamps of its own, and it splits multi-line output
 * into lines it then interleaves across requests and machines (a Node object
 * printed over eight lines arrives as eight unrelated lines). So each line here
 * carries its own `ts`, `level`, `event`, the machine it came from and, inside
 * a request, that request's context, and nothing ever spans two lines: an
 * incident window can be paged by time and matched against Manufact analytics
 * events (time, mcp_method, tool, client, status, duration).
 *
 * Never log credentials, email bodies or message content. Every string field
 * passes through `redact`, which masks email addresses (API error messages
 * quote recipients), AgentMail API keys, bearer tokens and JWTs, and replaces
 * Clerk ids with their hashId, as a backstop for whatever a caller forgot.
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import crypto from 'node:crypto'
import os from 'node:os'
import { performance } from 'node:perf_hooks'
import util from 'node:util'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
export type LogFields = Record<string, unknown>

/**
 * What a request knows about itself, filled in as the pipeline learns it. Every
 * line logged while the request runs carries these fields plus `duration_ms`
 * since it arrived.
 */
export type RequestLogContext = {
    req_id: string
    /** performance.now() when the request arrived. */
    started: number
    mcp_method?: string
    tool?: string
    client_name?: string
    client_version?: string
    /** The User-Agent, logged while clientInfo is unknown (2025-era calls after initialize). */
    ua?: string
    auth?: 'oauth' | 'api_key' | 'none'
    /** hashId of the API key or Clerk user. */
    actor?: string
    /** hashId of the AgentMail organization, once resolved (OAuth tool calls). */
    org?: string
    /** The AgentMail API's id for a call it failed (apigw-requestid), to find it in the API's logs. */
    api_request_id?: string
}

// Fly sets FLY_MACHINE_ID; elsewhere the hostname tells processes apart.
const MACHINE = process.env.FLY_MACHINE_ID || os.hostname()

const requestContexts = new AsyncLocalStorage<RequestLogContext>()

/** The context of the request this code is running for, if any. */
export function currentRequestContext(): RequestLogContext | undefined {
    return requestContexts.getStore()
}

/** Run `fn` with `context` as the current request context. */
export function runWithRequestContext<T>(context: RequestLogContext, fn: () => T): T {
    return requestContexts.run(context, fn)
}

/**
 * Run `fn` outside any request context. For work one request starts on behalf
 * of all of them (a memoized fetch), whose lines must not carry that request's
 * id forever.
 */
export function outsideRequestContext<T>(fn: () => T): T {
    return requestContexts.exit(fn)
}

/** Add what the pipeline just learned about the current request to every later line. */
export function annotateRequest(fields: Partial<Omit<RequestLogContext, 'req_id' | 'started'>>): void {
    const context = requestContexts.getStore()
    if (context) Object.assign(context, fields)
}

/** A fresh context for an arriving request. */
export function createRequestContext(userAgent?: string): RequestLogContext {
    return {
        req_id: crypto.randomBytes(8).toString('hex'),
        started: performance.now(),
        ...(userAgent && { ua: userAgent.slice(0, 120) }),
    }
}

/**
 * A stable pseudonym for a credential or account id: the first 12 hex
 * characters of SHA-256 over "agentmail-mcp:" and the value. The prefix keeps
 * it from matching any other system's plain hash of the same key. To find a
 * key or user in the logs, hash it the same way:
 * `printf 'agentmail-mcp:%s' "$id" | shasum -a 256 | cut -c1-12`.
 */
export function hashId(value: string): string {
    return crypto.createHash('sha256').update(`agentmail-mcp:${value}`).digest('hex').slice(0, 12)
}

const REDACTIONS: Array<[RegExp, string | ((match: string, kind: string) => string)]> = [
    [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>'],
    [/\bam_[A-Za-z0-9_-]{8,}/g, 'am_<redacted>'],
    [/\bsk_(?:live|test)_[A-Za-z0-9]+/g, 'sk_<redacted>'],
    [/\b(Bearer|Basic)\s+[^\s"',]+/gi, '$1 <redacted>'],
    [/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g, '<jwt>'],
    // Clerk ids in error messages become the same pseudonym `actor` uses.
    [/\b(user|org)_[A-Za-z0-9]{16,}\b/g, (match, kind) => `${kind}:${hashId(match)}`],
]
const MAX_STRING = 2000

/** Mask credentials, email addresses and Clerk ids in free text, and bound its length. */
export function redact(text: string): string {
    // Bound the regex work first, dropping a token the cut may have split so no
    // half of an address escapes the patterns; redact; then cut to size.
    let out = text.length > 4 * MAX_STRING ? text.slice(0, 4 * MAX_STRING).replace(/\S*$/, '') : text
    for (const [pattern, replacement] of REDACTIONS) {
        out = typeof replacement === 'string' ? out.replace(pattern, replacement) : out.replace(pattern, replacement)
    }
    return out.length > MAX_STRING ? `${out.slice(0, MAX_STRING)}…` : out
}

function scrub(value: unknown, depth = 0): unknown {
    if (typeof value === 'string') return redact(value)
    if (typeof value === 'bigint') return value.toString()
    if (value === null || typeof value !== 'object') return value
    // An Error's enumerable fields can hold a whole API response; name and message only.
    if (value instanceof Error) return { error_type: value.name, error: redact(value.message.split('\n')[0]!) }
    if (depth >= 4) return '[object]'
    if (Array.isArray(value)) return value.slice(0, 50).map((entry) => scrub(entry, depth + 1))
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, scrub(entry, depth + 1)]))
}

type LogSink = (level: LogLevel, line: string) => void

let streamGuarded = false
const standardSink: LogSink = (_level, line) => {
    // One stream for every level: the collector reads stdout and stderr at
    // different cadences, which reorders lines across the two. `level` says
    // what stderr used to.
    if (!streamGuarded) {
        streamGuarded = true
        // console ignores a closed pipe (EPIPE); a bare write would emit
        // 'error' with no listener and take the process down.
        process.stdout.on('error', () => {})
    }
    process.stdout.write(`${line}\n`)
}

let sink: LogSink = standardSink

/** Send lines somewhere else (tests); returns the function that restores the previous sink. */
export function setLogSink(next: LogSink): () => void {
    const previous = sink
    sink = next
    return () => {
        sink = previous
    }
}

// A ceiling on the whole process, under the per-key sampling below: if a bug
// ever logs per request, the cost is a dropped count on the stats line, not a
// saturated pipe (writes to one are synchronous on Linux).
const MAX_LINES_PER_SECOND = 100
let rateWindowStart = 0
let rateWindowLines = 0

const linesWritten: Record<LogLevel, number> = { debug: 0, info: 0, warn: 0, error: 0 }
let linesSuppressed = 0
let linesDropped = 0
let logging = false

/** Write one line. Fields override request context fields of the same name. */
export function log(level: LogLevel, event: string, fields: LogFields = {}): void {
    // Something reached while writing a line (a getter, the console bridge) logging again.
    if (logging) return
    if (event !== 'stats') {
        const now = Date.now()
        if (now - rateWindowStart >= 1000) {
            rateWindowStart = now
            rateWindowLines = 0
        }
        if (++rateWindowLines > MAX_LINES_PER_SECOND) {
            linesDropped++
            return
        }
    }
    logging = true
    try {
        const context = requestContexts.getStore()
        const line: LogFields = { ts: new Date().toISOString(), level, event, machine: MACHINE }
        if (context) {
            // The User-Agent only matters while clientInfo is unknown.
            const { started, ua, ...known } = context
            Object.assign(line, known, known.client_name ? {} : { ua })
            line.duration_ms = Math.round((performance.now() - started) * 10) / 10
        }
        Object.assign(line, fields)
        let text: string
        try {
            text = JSON.stringify(scrub(line))
        } catch (error) {
            text = JSON.stringify({ ts: line.ts, level, event, machine: MACHINE, log_error: String(error).slice(0, 200) })
        }
        linesWritten[level]++
        sink(level, text)
    } finally {
        logging = false
    }
}

// Per-key sampling, so a client that repeats the same mistake cannot flood the
// log window. Suppressed lines are counted by event and reported on the next
// stats line, so the totals stay exact while the lines are capped.
const SAMPLE_WINDOW_MS = 60_000
const MAX_SAMPLE_KEYS = 1000
let sampleWindowStart = Date.now()
const sampleCounts = new Map<string, number>()
const suppressedByEvent = new Map<string, number>()

/** Whether another line for `key` fits in this minute's `perMinute` budget. */
export function sampled(event: string, key: string, perMinute: number): boolean {
    const now = Date.now()
    if (now - sampleWindowStart >= SAMPLE_WINDOW_MS) {
        sampleCounts.clear()
        sampleWindowStart = now
    }
    // Keys come partly from client input (tool names, error kinds); past the
    // cap every new key shares one budget instead of growing the map.
    const bucket = sampleCounts.has(key) || sampleCounts.size < MAX_SAMPLE_KEYS ? key : '(overflow)'
    const count = sampleCounts.get(bucket) ?? 0
    if (count < perMinute) {
        sampleCounts.set(bucket, count + 1)
        return true
    }
    suppressedByEvent.set(event, (suppressedByEvent.get(event) ?? 0) + 1)
    linesSuppressed++
    return false
}

/** `log`, at most `perMinute` lines per `key`. */
export function logSampled(level: LogLevel, event: string, key: string, perMinute: number, fields: LogFields = {}): void {
    if (sampled(event, key, perMinute)) log(level, event, fields)
}

/** Lines suppressed by sampling since the last call, by event. */
export function takeSuppressed(): Record<string, number> {
    const counts = Object.fromEntries(suppressedByEvent)
    suppressedByEvent.clear()
    return counts
}

/** Totals for /health and the stats line. */
export function logCounters() {
    return { lines: { ...linesWritten }, suppressed_total: linesSuppressed, dropped_total: linesDropped }
}

/** Forget the sampling and rate windows (tests). */
export function resetSampling(): void {
    sampleCounts.clear()
    suppressedByEvent.clear()
    sampleWindowStart = Date.now()
    rateWindowStart = 0
    rateWindowLines = 0
}

/**
 * The fields to log for a thrown value: its class and the first line of its
 * message, bounded, plus the top stack frames on one line when `stack` is set.
 * Use it for errors nobody expected; an expected one needs no stack.
 */
export function errorFields(error: unknown, { stack = false } = {}): LogFields {
    if (!(error instanceof Error)) return { error: String(error).split('\n')[0]!.slice(0, 300) }
    const fields: LogFields = { error_type: error.name, error: error.message.split('\n')[0]!.slice(0, 300) }
    if (stack && error.stack) {
        const frames = error.stack
            .split('\n')
            .filter((frame) => /^\s*at\s/.test(frame))
            .slice(0, 8)
            .map((frame) => frame.trim().slice(0, 200))
        if (frames.length > 0) fields.stack = frames.join(' | ')
    }
    return fields
}

// Bounds applied while formatting, so a library logging a huge object costs a
// few kilobytes of work, not megabytes formatted and then cut.
const CONSOLE_INSPECT: util.InspectOptions = {
    depth: 3,
    maxArrayLength: 20,
    maxStringLength: 500,
    breakLength: Infinity,
    compact: true,
}

/**
 * Turns console output into log lines, so nothing in the process (this server,
 * agentmail-toolkit, the MCP and Clerk SDKs, Express) can print a multi-line
 * object into the shared stream. `intercept` sees each call first and returns
 * true for the ones it logged itself. Installed by the listening process only,
 * so importing the module (tests, the manifest generator) leaves console alone.
 */
export function installConsoleBridge(intercept?: (level: LogLevel, args: unknown[]) => boolean): void {
    const levels = { debug: 'debug', log: 'info', info: 'info', warn: 'warn', error: 'error' } as const
    for (const [method, level] of Object.entries(levels)) {
        console[method as keyof typeof levels] = (...args: unknown[]) => {
            if (logging) return
            // A console call must never throw into the code that made it.
            try {
                if (intercept?.(level, args)) return
            } catch {
                // Fall through and log the call as it came.
            }
            try {
                const msg = util.formatWithOptions(CONSOLE_INSPECT, ...args)
                logSampled(level, 'console', `console:${msg.slice(0, 60)}`, 30, { msg })
            } catch {
                // Unformattable arguments (a throwing inspect hook): nothing to write.
            }
        }
    }
}
