# AgentMail MCP Server

[![npm](https://img.shields.io/npm/v/agentmail-mcp)](https://www.npmjs.com/package/agentmail-mcp)

Connect any MCP-compatible AI client to email via [AgentMail](https://agentmail.to) — the email API for AI agents.

Works with Claude Desktop, Cursor, Windsurf, and any client that supports [Model Context Protocol](https://modelcontextprotocol.io).

## Setup

1. Get a free API key at [console.agentmail.to](https://console.agentmail.to)
2. Add to your MCP client config:

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

### Install via Smithery

```bash
npx @smithery/cli@latest mcp add agentmail
```

## Tool Selection

By default, all available tools are loaded. You can selectively enable specific tools using the `--tools` argument with a comma-separated list of tool names.

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

## What Your Agent Can Do

- **Create inboxes** — give each agent its own email address
- **Send & receive email** — full two-way email communication
- **Reply in threads** — maintain conversation context
- **Manage attachments** — send and receive files
- **Search emails** — semantic search across inbox content
- **Organize with labels** — tag and filter messages

## Links

- [AgentMail](https://agentmail.to) — The email API for AI agents
- [Documentation](https://docs.agentmail.to)
- [Python SDK](https://github.com/agentmail-to/agentmail-python)
- [TypeScript SDK](https://github.com/agentmail-to/agentmail-node)
- [AgentMail Toolkit](https://github.com/agentmail-to/agentmail-toolkit) — OpenAI + Vercel AI SDK integrations
- [Discord](https://discord.gg/ZYN7f7KPjS)
