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
