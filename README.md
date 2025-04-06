# AgentMail MCP Server

The AgentMail MCP Server provides tools for the AgentMail API.

## Setup

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
