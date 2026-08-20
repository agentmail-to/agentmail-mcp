# Operations

The production endpoint is `https://mcp.agentmail.to/mcp`. Preserve the existing production project, domain, environment, analytics, deployment history, and rollback revisions when changing its source repository.

Before promotion, record real baseline health, latency, authenticated completion, and tool-call success. Verify `/health`, OAuth discovery, a direct authenticated read, a representative write, npm stdio, PyPI stdio, and the runtime contract.

## Clerk OAuth configuration

The hosted server advertises `openid`, `email`, and `profile` through protected-resource metadata. Some clients, including ChatGPT, omit `scope` during dynamic client registration and rely on Clerk's instance defaults. Production must therefore keep all of these settings:

- Dynamic OAuth client registration enabled
- JWT access tokens enabled
- Default scopes containing `openid`, `email`, and `profile`

Check an instance without changing it:

```bash
CLERK_SECRET_KEY=sk_live_... pnpm check:oauth-config
```

Changing the defaults only fixes future registrations. Existing OAuth applications that were registered without `openid` must be updated to include it or re-registered; otherwise Clerk rejects ChatGPT's authorization request with `invalid_scope`.

Keep human GET navigation separate from MCP protocol traffic. Human pages may redirect to documentation. Authenticated MCP POST requests must stay on the same runtime or be served by a protocol alias, not redirected across origins.

The deployment provider is an implementation detail. Operational alerts and dashboards should identify the AgentMail hosted MCP, repository commit, and production project revision.

Authentication hardening is a separate rollout. This migration preserves the current hosted inputs and observable behavior.

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
