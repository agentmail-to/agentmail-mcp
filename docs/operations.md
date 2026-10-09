# Operations

The production endpoint is `https://mcp.agentmail.to/mcp`. Preserve the existing production project, domain, environment, analytics, deployment history, and rollback revisions when changing its source repository.

Before promotion, record real baseline health, latency, authenticated completion, and tool-call success. Verify `/health`, OAuth discovery, a direct authenticated read, a representative write, npm stdio, PyPI stdio, and the runtime contract.

## Clerk OAuth configuration

The hosted server advertises `openid`, `email`, `profile`, and `user:org:read` through protected-resource metadata. MCP SDK clients copy that list into their dynamic client registration and request it at authorization; Clerk rejects the whole authorization with `invalid_scope` if the client was not allowed any one of them. Some clients, including ChatGPT, omit `scope` during registration and are granted Clerk's instance defaults instead. Production must therefore keep all of these settings:

- Dynamic OAuth client registration enabled
- JWT access tokens enabled
- Default scopes for dynamic clients containing `openid`, `email`, `profile`, and `user:org:read` (Clerk Dashboard → OAuth applications → Settings)

Check an instance without changing it:

```bash
CLERK_SECRET_KEY=sk_live_... pnpm check:oauth-config
```

`user:org:read` is what puts the user's consent-screen organization choice into the token as `org_id`; without it, multi-org users fall back to the `select_organization` tool.

Changing the defaults only fixes future registrations. A client registered before a scope was allowed keeps its original allowed set, so advertising a new scope breaks every existing installation on its next authorization until those clients are backfilled. `user:org:read` was advertised from 2026-05-08 and withdrawn on 2026-06-18 for exactly this reason. It was re-advertised on 2026-09-24, and on 2026-09-26 Clerk backfilled `user:org:read` and `openid` onto every existing dynamic client in production (~330k). The `openid` pass also repaired the oldest clients, registered before `openid` was advertised on 2026-08-03, which had been failing re-authorization since then.

To add another scope, repeat the sequence: add it to the dynamic-client defaults, deploy the metadata change, then have Clerk backfill every dynamic client created before that deploy (Clerk runs it; the Backend API cannot address a dynamic client by its `client_id`). Existing clients that re-authorize between the deploy and the end of the backfill fail, so keep that window short.

Keep human GET navigation separate from MCP protocol traffic. Human pages may redirect to documentation. Authenticated MCP POST requests must stay on the same runtime or be served by a protocol alias, not redirected across origins.

The deployment provider is an implementation detail. Operational alerts and dashboards should identify the AgentMail hosted MCP, repository commit, and production project revision.

Authentication hardening is a separate rollout. This migration preserves the current hosted inputs and observable behavior.

## Clerk dependency

Every OAuth tool call needs Clerk's Backend API (membership lookup, and for multi-org users the stored selection); `@clerk/backend` has no request timeout and ignores the request's abort signal. Three bounds keep a slow or rate-limited Clerk from occupying every admission slot:

- `AGENTMAIL_CLERK_TIMEOUT_MS` (default 5000, floor 500): the caller stops waiting and the tool returns a retryable error. The underlying call stays counted until Clerk answers.
- `AGENTMAIL_MAX_CLERK_IN_FLIGHT` (default 64): above it, OAuth tool calls fail instantly with a retry message instead of queueing; API-key calls are unaffected.
- `AGENTMAIL_MEMBERSHIP_CACHE_TTL_MS` (default 300000): a user's organization list is cached per process. Removing someone from an organization takes effect on this server within that TTL, which is far tighter than the 24-hour access token. Empty lists and failures are never cached; the stored `select_organization` choice is never cached.

`/health` reports `requests.clerk` (in flight, timeouts, shed, cache size). Set `CLERK_JWT_KEY` (the instance's JWT public key, Clerk Dashboard → API keys) in the deployment environment so access-token verification never needs the JWKS fetch; the secret key stays required for the Backend API calls above.

An expired or rejected OAuth token gets the same `401` + `WWW-Authenticate` challenge as a missing one, so clients restart discovery instead of retrying a dead token.

## Overload protection

The server sheds load instead of queueing it. Two independent triggers, either of
which returns `503` with `Retry-After` before the request costs a per-request MCP
server or a Clerk verification:

- Event loop lag above `AGENTMAIL_MAX_EVENT_LOOP_LAG_MS` (default 500). This is
  the primary trigger. Under saturation a request waits in the kernel and libuv
  queues long before Express routes it, so an in-flight counter reads low while
  real latency is already seconds — measuring the loop catches the backlog
  wherever it sits.
- In-flight requests at or above `AGENTMAIL_MAX_IN_FLIGHT` (default 256). A
  secondary bound on the live set, since every in-flight request pins a whole
  McpServer, transport, and req/res.

Ordering matters as much as the limits. Clerk authentication and JSON body
parsing are mounted *inside* the MCP pipeline, after the admission gate, not as
globals. As globals every request paid both before it could be shed, which is the
cost shedding exists to avoid and the cost that accumulates during a retry storm.

`AGENTMAIL_REQUEST_TIMEOUT_MS` (default 30000) reclaims any request that would
otherwise hold a slot indefinitely. Before headers go out it returns `504`. Once
they have, it destroys the connection instead — `StreamableHTTPServerTransport`
writes SSE headers before a `tools/call` handler settles, so every hung tool call
is already past the point where a status can be sent, and a timeout that merely
returned there would be a no-op for exactly the requests that need it.

`AGENTMAIL_SHED_RETRY_AFTER_SECONDS` (default 2) sets the `Retry-After` value.

A `504` marks the request as timed out, and the MCP handler refuses to run a
tool for a request that has already been answered or whose client has gone.
Otherwise a slow body upload or Clerk round trip that outlived the timeout
would resume, build a server, and execute the tool (send the email) into a
closed response that the client already saw fail and will retry.
`requests.skipped_after_timeout` in `/health` counts these.

JSON-RPC batch bodies (arrays) are rejected with `400`. Batching was removed
from the MCP spec in 2025-06-18 and no client seen here sends one, but the SDK
transport still dispatches up to 100 messages from one array, which would put
100 tool calls through one admission slot. `requests.batches_rejected` counts
them.

## Graceful shutdown

On `SIGTERM` or `SIGINT` the server stops accepting, closes idle keep-alive
connections, answers `/health` with `503 draining`, sheds new MCP requests with
`503` + `Retry-After` + `Connection: close`, and waits for in-flight requests
for up to `AGENTMAIL_DRAIN_TIMEOUT_MS` (default 8000) before exiting. Without
this every deploy killed in-flight tool calls after their upstream side effect
and reset every open connection at once, which clients answered with a
synchronized reconnect at the replacement process. The platform's own kill
grace period bounds the window from outside; if it is shorter than the drain
timeout the drain is simply cut short, never worse than before.

A slot is held until the handler settles, not until the client disconnects, and
the MCP request's abort signal is injected into the AgentMail SDK through a custom
`fetch`. agentmail-toolkit does not forward `extra.signal`, so without that a
client abort left the upstream HTTP request running to completion while the server
reported zero in flight — letting timed-out clients rebuild unbounded background
work behind a cap that looked healthy.

Shedding is self-healing: it clears as soon as the next sample is under the
limits, and logs only the transitions, never the individual sheds.

Watch `requests` in `/health` — `in_flight`, `event_loop_lag_ms`, and `shed_total`.
Note that `https://mcp.agentmail.to/health` is answered by the Manufact gateway and
never reaches the app, so it stays green during an outage. Probe the app's own
`/health` on the deployment's `.fly.dev` host, or an MCP `ping`, for real signal.

## Accept backlog

`app.listen` is given an explicit backlog (`AGENTMAIL_LISTEN_BACKLOG`, default 2048,
bounded by the kernel's `somaxconn`). Node's default when the argument is omitted is
511, and that 511 was the cap the 2026-08-20 outage overflowed: the Fly proxy opens
one connection per request and drives bursts past the steady rate, a burst filled the
queue in a single event-loop tick before the accept callback ran again, and the kernel
dropped the completed handshakes. Those drops are silent — nothing in Node or the proxy
logs them — and the proxy's retries showed up only as multi-second latency on requests
that had not yet reached Express.

The signal is `tcp.tcp_ext.ListenOverflows` in `/health` (equal to `ListenDrops`); any
increase is dropped connections. The server logs `[accept] backlog overflow` on the
transition and `sockets.accepted_total` / `tcp.port.acceptQueue` show the pressure.
If overflows persist at a raised backlog, the burst rate exceeds what one machine can
accept and the levers are reducing per-request work on the accept path and horizontal
scale.

## CPU steal

`/health` reports `cpu.steal_pct` — the share of the last second the hypervisor
refused to schedule this vCPU, from `/proc/stat`. On a shared-CPU machine the
quota freeze is invisible to the process and its logs; steal is the one number
that separates "our code is slow" from "the host is withholding CPU". Sustained
steal above 50% logs `[cpu] steal pressure` and means the machine size, not the
code, is the constraint.

## Protocol fast path

`initialize`, `notifications/initialized`, and `tools/list` are 93% of
non-ping traffic and have constant answers on this server (the same tools are
registered for every request). They are answered after authentication from a
snapshot taken once through the SDK's own client over an in-memory transport,
so the cached bytes are what the full path would have produced. Only the
request id and the negotiated protocol version vary per request. Measured CPU
per request: initialize 0.80 → 0.14 ms, initialized 0.71 → 0.13 ms,
tools/list 2.35 → 0.33 ms.

A body the SDK's strict schemas would reject (extra keys, a missing
`clientInfo.version`, an unsupported `mcp-protocol-version` header) falls
through to the SDK and gets its error, never a cached success. Authentication
is unchanged: the fast path sits after the auth router. `/health` reports
`requests.protocol_fast_path`; `AGENTMAIL_PROTOCOL_FAST_PATH=0` disables it.

## Ping fast path

MCP `ping` (about two thirds of all traffic) is answered immediately after body
parsing — before Clerk verification and before a per-request MCP server is
built — as a plain `application/json` JSON-RPC response. This cuts the CPU cost
of a ping from ~3.7 ms to ~0.05 ms, which matters on a CPU-quota-limited
machine. Pings are deliberately not rate limited and need no credentials: a
rejected or dropped ping makes clients tear down and re-initialize (three
full-path requests, ~200x the cost of answering), so the answer itself is the
cheapest defense. `requests.pings_fast_path` in `/health` counts them.
