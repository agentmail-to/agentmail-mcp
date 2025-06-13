# AgentMail MCP Server
[![smithery badge](https://smithery.ai/badge/@agentmail-to/agentmail-mcp)](https://smithery.ai/server/@agentmail-to/agentmail-mcp)

The AgentMail MCP Server provides tools for the AgentMail API.

## Setup

### Installing via Smithery

To install AgentMail MCP Server for Claude Desktop automatically via [Smithery](https://smithery.ai/server/@agentmail-to/agentmail-mcp):

```bash
npx -y @smithery/cli install @agentmail-to/agentmail-mcp --client claude
```

### Credentials

Get your API key from [AgentMail](https://agentmail.to)

### Configuration

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

