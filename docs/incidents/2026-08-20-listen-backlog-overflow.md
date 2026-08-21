# 2026-08-20 — Hosted MCP unreachable (accept-backlog overflow)

## Summary

`https://mcp.agentmail.to` became effectively unreachable: the process stayed
up and `/health` at the gateway stayed green, but every MCP request took 7–20 s
and clients (Claude Desktop, Cursor, Codex, the npm/PyPI bridges) timed out and
reported the connector as down.

Root cause: `app.listen(PORT)` was called with no backlog argument, so the
kernel accept queue was capped at Node's default of **511**. The Manufact/Fly
proxy opens one connection per request and drives bursts well past the steady
rate; a burst filled the 511-slot queue in a single event-loop tick, the kernel
dropped the completed TCP handshakes, and the proxy's retries surfaced as
multi-second latency entirely upstream of the application.

Fix: set an explicit backlog (`AGENTMAIL_LISTEN_BACKLOG`, default 2048, bounded
by the kernel's `somaxconn` of 4096). One argument.

## Impact

- All hosted MCP clients, intermittently then persistently. Onset consistently
  ~10–13 minutes after a fresh machine started; a redeploy restored service for
  about that long before the queue rebuilt.
- Read and write tools alike — the stall was before routing, so even a `405`
  for `GET /mcp` was as slow as a real `tools/call`.
- No data loss. No crash. Heap and CPU were healthy throughout.

## Timeline (UTC, 2026-08-20)

- **~18:40 (prev. day 08-19)** — first degradation. Traffic flat, no deploy
  since 08-13. p50 across every method jumped from ~60 ms to ~3 s in five
  minutes.
- **17:46 (08-20)** — investigation begins. Gateway `/health` green (80 ms);
  the app's own `/health` on the `.fly.dev` host takes 13 s.
- **18:19** — redeploy #114 onto a fresh machine. Recovers to ~0.2 s.
- **18:28** — degrades again after ~8 minutes. Redeploy is not a fix.
- **~20:15** — #43 (admission control + observability) deployed as #117.
  Confirms the queue is not inside Node: event-loop lag 20 ms while latency is
  9 s, `shed_total` 0, in-flight 0–2.
- **~20:40** — #44 (FD/socket telemetry) as #119. Rules out descriptor
  exhaustion (30 of 10240). New fact: the accept rate halves (95→45/s) the
  moment latency rises.
- **~21:04** — #45 (kernel TCP telemetry from /proc) as #121. The listen
  socket's accept queue pegs at ~512, `ListenOverflows == ListenDrops` step up
  in bursts (3378 → 4111 → 5729), `PAWSPassive`/`TCPTimeWaitOverflow` stay 0.
  Root cause identified.
- **~21:20** — #46 (this fix) opened.

## Evidence

Kernel counters on production machine #121 during degradation, from
`/health.tcp` (added in #45):

```
acceptQueue (listen rx_queue) : 382, 512, 506, 512   ← pegged at the backlog
port.states.established       : 345, 507, 504         ← accepted by kernel, not by Node
ListenOverflows == ListenDrops: 3378 → 3631 → 4111 → 5458 → 5729
event_loop_lag_ms             : 20–96                 ← Node near idle
in_flight                     : 0–3
PAWSPassive / TCPTimeWaitOverflow / TWRecycled : 0
```

A `GET /mcp` (answered `405` by the first middleware, before admission, body
parsing, and auth) took 10.0 s / 12.4 s on the production machine while an idle
sibling on the identical image answered in 0.13 s — the wait was between the
proxy handing over a connection and Node's first line running.

## What it was not (ruled out with measurement, not argument)

- **A bad machine.** A fresh machine degraded identically in ~8 minutes.
- **Capacity.** An idle machine on the same image served 268 req/s at 512
  concurrent with zero sheds; demand was 30–60 req/s.
- **Memory / GC.** Heap 74–92 MB of 493, RSS flat.
- **The AgentMail API.** An MCP `ping` does no upstream I/O and was equally slow.
- **The Manufact gateway.** The direct `.fly.dev` URL was equally slow.
- **Per-request `McpServer` construction.** Benchmarked at 0.31 ms for 26 tools.
- **Clerk JWKS per request.** kid was in the cached JWKS; TTL 5 min.
- **FD exhaustion.** 30 of 10240 open descriptors throughout.
- **TIME_WAIT churn.** `PAWSPassive` and `TCPTimeWaitOverflow` stayed 0.
- **Load shedding as the fix.** The queue is in the kernel, before `accept()`,
  where admission control cannot see it.

## Why it took three diagnostic rounds

The failure was invisible from every vantage point the service had. Gateway
`/health` never reached the app. The app's own `/health` reported a healthy
heap, because the failure mode is connections, not memory. `ListenOverflows` —
the one counter that named the cause — is silent: nothing in Node or the proxy
logs a dropped handshake. Each round (#43 admission + loop-lag, #44 FD/socket,
#45 kernel TCP) added the specific telemetry that ruled a layer in or out, until
the kernel counters were the only place left to look and the answer was there.

## Follow-ups

- Watch `tcp.tcp_ext.ListenOverflows` in `/health` after deploy; the server now
  logs `[accept] backlog overflow` on the transition, so it will never again
  require manual inspection.
- If overflows persist at backlog 2048, the burst rate exceeds one machine's
  accept throughput: reduce per-request allocation on the accept path (lag
  reached ~100–190 ms during bursts, stretching the gap between `accept()`
  calls) and scale horizontally.
- Point external monitoring at the app's own `/health` or an MCP `ping`, not the
  gateway `/health`, which cannot see an application-level outage.

## Addendum (2026-08-20, later the same day): the layer beneath the backlog

The backlog fix removed the collapse amplifier — `ListenOverflows` froze where
it had been climbing by thousands — but baseline latency stayed at 5–20 s. The
constraint beneath it was measured directly with CPU-steal telemetry
(`/health.cpu`, from `/proc/stat`): on a fresh machine, at minute ~8, steal
jumped from 1% to 46–63% while busy pinned at 4–5% — a shared-CPU machine's
~6.25% quota being enforced after its burst balance drained. The arithmetic
closes: ~3.7 ms CPU per request against a ~62 ms/s sustained budget is
~17 req/s of capacity, exactly the observed plateau, and the burst-balance
drain is why every fresh machine was healthy for ~8–14 minutes before
degrading. Remedy is provider-side (dedicated-CPU machine, ≥2 machines; the
hosting API exposes no size control). On our side, the ping fast path cuts
per-request CPU for two thirds of traffic by ~70x, roughly doubling sustained
capacity on the same quota.
