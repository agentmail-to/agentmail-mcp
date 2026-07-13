# AgentMail MCP Server

> **Deprecated:** AgentMail now runs a hosted MCP server at [`https://mcp.agentmail.to/mcp`](https://mcp.agentmail.to/mcp) (see [docs](https://docs.agentmail.to/integrations/mcp)). This local stdio package is no longer maintained. New integrations should use the hosted endpoint:
>
> ```json
> {
>     "mcpServers": {
>         "AgentMail": {
>             "url": "https://mcp.agentmail.to/mcp?apiKey=YOUR_API_KEY"
>         }
>     }
> }
> ```

The AgentMail MCP Server provides tools for the AgentMail API.

## Legacy (local stdio) setup

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

### Tool Selection

By default, all available tools are loaded. You can selectively enable specific tools using the `--tools` argument with a comma-separated list of tool names.

#### Example

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
