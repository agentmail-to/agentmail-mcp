# AgentMail MCP Server

[![npm version](https://img.shields.io/npm/v/agentmail-mcp)](https://www.npmjs.com/package/agentmail-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

Give any MCP-compatible AI agent a **real email inbox** — send, receive, reply, forward, and manage threads programmatically.

Unlike traditional email APIs (SendGrid, Resend, SES) that only handle *sending*, AgentMail provides **two-way email** for autonomous AI agents: full inbox management, real-time message reception via webhooks/websockets, thread tracking, and attachment handling.

## Why AgentMail for MCP?

- **Full inbox, not just sending** — agents can receive, read, and reply to emails autonomously
- **Instant setup** — `npx agentmail-mcp` and your agent has an email address. No domain verification, no DNS records
- **17 tools included** — complete email lifecycle from inbox creation to thread management
- **Works everywhere** — Claude Desktop, Cursor, Windsurf, Cline, and any MCP-compatible client
- **Built for agents** — designed from the ground up for AI agent workflows, not adapted from human email

## Quick Start

### 1. Get an API Key

Sign up at [agentmail.to](https://agentmail.to) and grab your API key.

### 2. Configure Your MCP Client

#### Claude Desktop

Add to your `claude_desktop_config.json`:

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

#### Cursor

Add to your `.cursor/mcp.json`:

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

#### Windsurf

Add to your Windsurf MCP config:

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

## Available Tools

| Tool | Description | Read-only |
|------|-------------|-----------|
| `list_inboxes` | List all agent inboxes | ✅ |
| `get_inbox` | Get inbox details | ✅ |
| `create_inbox` | Create a new inbox (agent gets a real email address) | |
| `delete_inbox` | Delete an inbox | |
| `list_threads` | List email threads in an inbox | ✅ |
| `get_thread` | Get full thread with all messages | ✅ |
| `get_attachment` | Download and read email attachments | ✅ |
| `send_message` | Send an email from an agent inbox | |
| `reply_to_message` | Reply to a received email | |
| `forward_message` | Forward an email to another address | |
| `update_message` | Update message metadata (labels, read status) | |
| `create_draft` | Create a draft email, optionally scheduled with `send_at` | |
| `list_drafts` | List drafts, filter by labels (e.g. "scheduled") | ✅ |
| `get_draft` | Get draft content, status, and scheduled send time | ✅ |
| `update_draft` | Update draft content or reschedule | |
| `send_draft` | Send a draft immediately | |
| `delete_draft` | Delete a draft or cancel a scheduled send | |

## Tool Selection

Load only the tools your agent needs using the `--tools` flag:

```json
{
    "mcpServers": {
        "AgentMail": {
            "command": "npx",
            "args": ["-y", "agentmail-mcp", "--tools", "create_inbox,send_message,list_threads,get_thread,reply_to_message"],
            "env": {
                "AGENTMAIL_API_KEY": "YOUR_API_KEY"
            }
        }
    }
}
```

## Example Use Cases

- **Customer support agent** — receives support emails, reads them, drafts and sends replies
- **Recruiting coordinator** — sends outreach, tracks replies, follows up automatically
- **Legal intake** — receives inquiries, parses attachments, routes to the right team
- **Meeting scheduler** — sends availability, reads responses, confirms bookings
- **Invoice processor** — receives invoices via email, extracts data from attachments
- **Newsletter curator** — subscribes to sources, reads digests, compiles summaries

## Beyond MCP: Full SDK

For deeper integrations, AgentMail also provides:

- **Python SDK**: `pip install agentmail` — [GitHub](https://github.com/agentmail-to/agentmail-python)
- **TypeScript SDK**: `npm install agentmail` — [GitHub](https://github.com/agentmail-to/agentmail-toolkit)
- **LangChain integration**: [langchain-agentmail](https://github.com/agentmail-to/langchain-agentmail)
- **OpenAI Agents SDK** and **Vercel AI SDK** support via [agentmail-toolkit](https://github.com/agentmail-to/agentmail-toolkit)
- **Webhooks** for real-time event-driven workflows
- **WebSockets** for live, low-latency message streaming

## Links

- 🌐 [agentmail.to](https://agentmail.to) — Homepage
- 📖 [Documentation](https://docs.agentmail.to) — API Reference & Guides
- 🐙 [GitHub](https://github.com/agentmail-to) — All repos
- 📦 [npm: agentmail-mcp](https://www.npmjs.com/package/agentmail-mcp)

## License

MIT
