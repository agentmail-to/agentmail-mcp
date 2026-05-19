# AgentMail MCP Server

[![npm version](https://img.shields.io/npm/v/agentmail-mcp)](https://www.npmjs.com/package/agentmail-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

Give any MCP-compatible AI agent full email capabilities — create inboxes, send and receive emails, reply to threads, and manage conversations, all through the [Model Context Protocol](https://modelcontextprotocol.io/).

Built on [AgentMail](https://agentmail.to) — the email inbox API purpose-built for AI agents. Unlike traditional email APIs (SendGrid, Resend, Amazon SES) that only handle sending, AgentMail provides **two-way email** with real inboxes your agents can read, reply to, and manage autonomously.

## Why AgentMail MCP?

- **Real inboxes** — Each agent gets its own email address that can send _and_ receive
- **Threaded conversations** — Agents can follow and reply to email threads naturally
- **Webhook-driven** — Get notified when new emails arrive, no polling needed
- **Zero config email infra** — No SMTP servers, no DNS records, no domain verification
- **Works with any MCP client** — Claude Desktop, Cursor, Windsurf, Cline, and more

## Quick Start

### Claude Desktop

Add this to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

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

### Cursor

Add to `.cursor/mcp.json` in your project:

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

### Windsurf / Cline / Other MCP Clients

Use the same configuration pattern — set `command` to `npx`, `args` to `["-y", "agentmail-mcp"]`, and provide your API key in the `env` block.

> Get your API key at [agentmail.to](https://agentmail.to)

## Available Tools

| Tool | Description |
|------|-------------|
| `create_inbox` | Create a new email inbox for an agent |
| `list_inboxes` | List all inboxes in your account |
| `get_inbox` | Get details of a specific inbox |
| `update_inbox` | Update inbox settings (display name, webhook URL, etc.) |
| `send_message` | Send a new email from an agent inbox |
| `reply_to_message` | Reply to an existing email thread |
| `get_message` | Retrieve a specific email message |
| `list_messages` | List messages in an inbox |
| `list_threads` | List email threads in an inbox |
| `get_thread` | Get all messages in a thread |
| `list_contacts` | List contacts across inboxes |

## Tool Selection

By default, all tools are loaded. You can selectively enable specific tools using the `--tools` argument:

```json
{
  "mcpServers": {
    "AgentMail": {
      "command": "npx",
      "args": ["-y", "agentmail-mcp", "--tools", "send_message,get_message,reply_to_message,create_inbox"],
      "env": {
        "AGENTMAIL_API_KEY": "YOUR_API_KEY"
      }
    }
  }
}
```

This is useful for keeping the tool count low in clients with limited context windows.

## Example Use Cases

- **Customer support agent** — Auto-triage incoming emails and draft responses
- **Sales outreach agent** — Send personalized emails and handle replies autonomously
- **Scheduling agent** — Coordinate meetings via email threads
- **Legal intake agent** — Process incoming inquiries and collect information
- **Recruitment agent** — Screen candidates and manage interview scheduling via email

## Related Packages

| Package | Description |
|---------|-------------|
| [`agentmail`](https://www.npmjs.com/package/agentmail) | Node.js SDK for the AgentMail API |
| [`agentmail` (PyPI)](https://pypi.org/project/agentmail/) | Python SDK for the AgentMail API |
| [`agentmail-toolkit`](https://www.npmjs.com/package/agentmail-toolkit) | Agent framework integrations (OpenAI Agents SDK, Vercel AI SDK, MCP) |
| [`langchain-agentmail`](https://pypi.org/project/langchain-agentmail/) | LangChain integration |

## Links

- [Documentation](https://docs.agentmail.to)
- [API Reference](https://docs.agentmail.to/api-reference)
- [AgentMail Website](https://agentmail.to)
- [GitHub](https://github.com/agentmail-to)

## License

MIT
