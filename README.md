# AgentMail MCP

AgentMail has one MCP tool implementation, hosted at:

```text
https://mcp.agentmail.to/mcp
```

Use that Streamable HTTP endpoint directly when your client supports remote MCP. It provides the current runtime tool catalog and supports the hosted server's existing OAuth and per-request API-key paths. See the [AgentMail MCP documentation](https://docs.agentmail.to/integrations/mcp).

## stdio compatibility

Existing Node configurations continue to work through the npm bridge:

```json
{
  "mcpServers": {
    "AgentMail": {
      "command": "npx",
      "args": ["-y", "agentmail-mcp"],
      "env": { "AGENTMAIL_API_KEY": "YOUR_API_KEY" }
    }
  }
}
```

Python users can run the equivalent native bridge:

```sh
AGENTMAIL_API_KEY=YOUR_API_KEY uvx agentmail-mcp
```

Both bridges discover tools and schemas from the hosted server. They do not contain AgentMail SDK, toolkit, REST API, or tool-definition logic. `--tools name1,name2` remains available for stdio clients that need a filtered catalog.

## Repository

- `packages/server`: the hosted MCP server and only AgentMail tool implementation
- `packages/npm-stdio-bridge`: npm `agentmail-mcp`
- `python/stdio-bridge`: PyPI `agentmail-mcp`
- `mcp-manifest.json`: generated runtime contract
- `tests`: contract and transport checks
- `docs`: architecture, compatibility, migration, release, and operations

```sh
pnpm install
pnpm build
pnpm test
pnpm check:contract
```

The old local npm implementation is preserved at `legacy-local-v0.2.2`. Authentication hardening is a separate project; this consolidation preserves the hosted server's existing behavior.
