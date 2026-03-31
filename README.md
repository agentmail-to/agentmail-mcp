# AgentMail MCP Server

[![npm](https://img.shields.io/npm/v/agentmail-mcp)](https://www.npmjs.com/package/agentmail-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

The official [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server for [AgentMail](https://agentmail.to) — the email API built for AI agents.

Give any MCP-compatible AI assistant (Claude, Cursor, Windsurf, etc.) the ability to create email inboxes, send and receive messages, and manage threads — all through natural language.

## What It Does

- **Create inboxes on the fly** — your AI assistant can spin up a real email address in seconds
- **Send and receive emails** — full two-way email, not just sending
- **Manage threads** — read, reply, search, and organize email conversations
- **Handle attachments** — send and receive files via email
- **Real-time updates** — get notified when new emails arrive

## Quick Start

### 1. Get an API Key

Sign up at [console.agentmail.to](https://console.agentmail.to) and grab your API key.

### 2. Configure Your MCP Client

Add this to your MCP client configuration:

**Claude Desktop** (`claude_desktop_config.json`):
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

**Cursor** (`.cursor/mcp.json`):
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

### 3. Start Using It

Ask your AI assistant:
- *"Create a new email inbox for my sales agent"*
- *"Send an email to hello@example.com introducing our product"*
- *"Check my agent's inbox for new messages"*
- *"Reply to the latest email in my thread"*

## Available Tools

| Tool | Description |
|------|-------------|
| `create_inbox` | Create a new email inbox with a unique address |
| `list_inboxes` | List all inboxes in your account |
| `get_inbox` | Get details about a specific inbox |
| `send_message` | Send an email from any inbox |
| `list_messages` | List messages in an inbox |
| `get_message` | Read a specific email message |
| `list_threads` | List email threads in an inbox |
| `get_thread` | Get all messages in a thread |

## Tool Selection

By default, all tools are loaded. You can selectively enable specific tools:

```json
{
  "mcpServers": {
    "AgentMail": {
      "command": "npx",
      "args": ["-y", "agentmail-mcp", "--tools", "create_inbox,send_message,list_messages"]
    }
  }
}
```

## Links

- [AgentMail Website](https://agentmail.to)
- [API Documentation](https://docs.agentmail.to)
- [AgentMail Console](https://console.agentmail.to)
- [Python SDK](https://github.com/agentmail-to/agentmail-python)
- [TypeScript SDK](https://github.com/agentmail-to/agentmail-node)
- [Go SDK](https://github.com/agentmail-to/agentmail-go)

## License

MIT
