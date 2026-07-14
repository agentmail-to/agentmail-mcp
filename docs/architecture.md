# Architecture

AgentMail has one MCP tool and schema implementation: the hosted server in `packages/server`. Its canonical Streamable HTTP endpoint is:

```text
https://mcp.agentmail.to/mcp
```

The npm and PyPI packages are stdio compatibility transports. They obtain the tool catalog from the hosted server and forward MCP requests and responses. They do not import the AgentMail SDK or toolkit, define tool schemas, or call the AgentMail REST API.

Smithery is a listing or gateway for the same endpoint. Manufact is the current deployment provider. Neither is a separate AgentMail MCP product or source of tool behavior.

The runtime generates `mcp-manifest.json`. Tests, registry metadata, documentation, and both bridges use that contract instead of copied tool counts.

Authentication behavior is intentionally unchanged by this consolidation. Credential precedence, OAuth validation, organization authorization, and credential retirement belong to the separate authentication-hardening project.
