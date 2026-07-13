# agentmail-mcp

`agentmail-mcp` is the supported stdio compatibility bridge for the canonical hosted AgentMail MCP server at `https://mcp.agentmail.to/mcp`. It loads tools and schemas from that server at runtime; it does not contain a separate AgentMail tool implementation.

Prefer connecting an MCP client directly to the hosted endpoint when it supports Streamable HTTP. For stdio-only clients:

```json
{
    "mcpServers": {
        "AgentMail": {
            "command": "npx",
            "args": ["-y", "agentmail-mcp"],
            "env": {
                "AGENTMAIL_API_KEY": "YOUR_API_KEY"
            }
        }
    }
}
```

To expose only selected remote tools, add `"--tools", "list_inboxes,send_message"` to `args`. The API key is sent to the hosted server as `x-api-key` and is never written to stdout.

See the [AgentMail MCP documentation](https://docs.agentmail.to/integrations/mcp) for direct connection and migration guidance.
