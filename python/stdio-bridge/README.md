# AgentMail MCP stdio bridge

This package is the Python compatibility transport for the hosted AgentMail MCP
server. It contains no AgentMail tools or API client: tool definitions and calls
come from `https://mcp.agentmail.to/mcp` at runtime.

```bash
AGENTMAIL_API_KEY=... uvx agentmail-mcp
```

It also works after a normal `pip install agentmail-mcp` as `agentmail-mcp`.
Use `--tools list_inboxes,send_message` to expose only selected remote tools.
The legacy `--api-key` option remains accepted, but the environment variable is
preferred because command-line arguments may be visible to other local users.
