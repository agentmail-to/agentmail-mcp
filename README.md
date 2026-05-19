# AgentMail MCP Server

Give any AI agent a real email inbox. The AgentMail MCP Server lets Claude, Cursor, Windsurf, and any MCP-compatible client send, receive, and manage emails through the [AgentMail](https://agentmail.to) API.

> **Two-way email for AI agents** — not just sending. Create inboxes, read incoming mail, reply in threads, forward messages, and manage drafts. All via MCP tool calls.

[![npm version](https://img.shields.io/npm/v/agentmail-mcp)](https://www.npmjs.com/package/agentmail-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

## Why AgentMail?

Traditional email APIs (SendGrid, Resend, SES) are **send-only** — they can't give your agent its own inbox. Gmail/Outlook APIs require OAuth consent flows designed for humans and prohibit bot usage in their ToS.

AgentMail is **built from the ground up for AI agents**:

- 📬 **Full inbox management** — create, read, send, receive, reply, forward
- 🧵 **Automatic threading** — replies stay in the right conversation
- 📎 **Attachment support** — send and receive files
- 📝 **Draft management** — create, update, and send drafts
- 🔑 **One API key** — no OAuth flows, no browser needed
- ⚡ **Instant provisioning** — create a new inbox in one API call

## Quick Start

### 1. Get an API Key

Sign up at [agentmail.to](https://agentmail.to) to get your API key.

### 2. Configure Your Client

<details open>
<summary><strong>Claude Desktop</strong></summary>

Add to `claude_desktop_config.json`:

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

</details>

<details>
<summary><strong>Cursor</strong></summary>

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

</details>

<details>
<summary><strong>Windsurf</strong></summary>

Add to `~/.codeium/windsurf/mcp_config.json`:

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

</details>

<details>
<summary><strong>VS Code (GitHub Copilot)</strong></summary>

Add to `.vscode/mcp.json` in your project:

```json
{
  "servers": {
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

</details>

## Available Tools

| Tool | Description |
|------|-------------|
| `create_inbox` | Create a new email inbox for your agent |
| `list_inboxes` | List all inboxes |
| `get_inbox` | Get details of a specific inbox |
| `delete_inbox` | Delete an inbox |
| `send_message` | Send an email from an inbox |
| `reply_to_message` | Reply to a message within a thread |
| `forward_message` | Forward a message to another address |
| `update_message` | Update message properties (e.g., mark as read) |
| `list_threads` | List email threads in an inbox |
| `get_thread` | Get a specific thread with all messages |
| `get_attachment` | Download an email attachment |
| `create_draft` | Create a draft email |
| `list_drafts` | List all drafts in an inbox |
| `get_draft` | Get a specific draft |
| `update_draft` | Update a draft |
| `send_draft` | Send a draft |
| `delete_draft` | Delete a draft |

### Tool Selection

Load only the tools you need using the `--tools` flag:

```json
{
  "mcpServers": {
    "AgentMail": {
      "command": "npx",
      "args": ["-y", "agentmail-mcp", "--tools", "send_message,reply_to_message,list_threads,get_thread"],
      "env": {
        "AGENTMAIL_API_KEY": "YOUR_API_KEY"
      }
    }
  }
}
```

## Example Use Cases

- **Customer support agent** — auto-reply to inbound emails, escalate when needed
- **Scheduling assistant** — send meeting invites, process RSVPs from replies
- **Sales outreach agent** — send personalized emails, track and respond to replies
- **Notification system** — send alerts and collect responses via email
- **Hiring agent** — screen applicants, send follow-ups, coordinate interviews
- **Invoice processor** — receive invoices via email, extract data, send confirmations

## How It Compares

| Feature | AgentMail | Gmail API | Resend | SendGrid |
|---------|-----------|-----------|--------|----------|
| Create inboxes via API | ✅ | ❌ | ❌ | ❌ |
| Two-way email (send + receive) | ✅ | ✅* | ❌ | ❌ |
| No OAuth required | ✅ | ❌ | ✅ | ✅ |
| Built for AI agents | ✅ | ❌ | ❌ | ❌ |
| MCP server | ✅ | ❌ | ❌ | ❌ |
| Automatic threading | ✅ | ✅ | ❌ | ❌ |
| Draft management | ✅ | ✅ | ❌ | ❌ |

\* Gmail API requires OAuth consent flow and prohibits bot usage in ToS.

## Also Available

AgentMail works with your favorite agent frameworks:

- **[Python SDK](https://pypi.org/project/agentmail/)** — `pip install agentmail`
- **[TypeScript SDK](https://www.npmjs.com/package/agentmail)** — `npm install agentmail`
- **[LangChain integration](https://github.com/agentmail-to/langchain-agentmail)** — LangChain tools for AgentMail
- **[Agent Toolkit](https://github.com/agentmail-to/agentmail-toolkit)** — Vercel AI SDK, LangChain, and more

## Links

- 🌐 [agentmail.to](https://agentmail.to) — Homepage
- 📖 [Documentation](https://docs.agentmail.to) — API Reference
- 🐙 [GitHub](https://github.com/agentmail-to) — Source code & examples
- 💬 [Discord](https://discord.gg/agentmail) — Community & support

## License

MIT
