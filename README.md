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

## Tool Selection

By default, all available tools are loaded. You can selectively enable specific tools using the `--tools` argument with a comma-separated list of tool names.

### Example

```json
{
    "mcpServers": {
        "AgentMail": {
            "command": "npx",
            "args": ["-y", "agentmail-mcp", "--tools", "get_message,send_message,reply_to_message"],
            "env": {
                "AGENTMAIL_API_KEY": "YOUR_API_KEY"
            }
        }
    }
}
```
