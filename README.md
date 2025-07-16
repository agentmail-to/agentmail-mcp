[![MseeP.ai Security Assessment Badge](https://mseep.net/pr/agentmail-to-agentmail-mcp-badge.png)](https://mseep.ai/app/agentmail-to-agentmail-mcp)

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
