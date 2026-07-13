# Operations

The production endpoint is `https://mcp.agentmail.to/mcp`. Preserve the existing production project, domain, environment, analytics, deployment history, and rollback revisions when changing its source repository.

Before promotion, record real baseline health, latency, authenticated completion, and tool-call success. Verify `/health`, OAuth discovery, a direct authenticated read, a representative write, npm stdio, PyPI stdio, and the runtime contract.

Keep human GET navigation separate from MCP protocol traffic. Human pages may redirect to documentation. Authenticated MCP POST requests must stay on the same runtime or be served by a protocol alias, not redirected across origins.

The deployment provider is an implementation detail. Operational alerts and dashboards should identify the AgentMail hosted MCP, repository commit, and production project revision.

Authentication hardening is a separate rollout. This migration preserves the current hosted inputs and observable behavior.
