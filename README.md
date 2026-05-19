# AgentMail MCP Server

[![npm version](https://img.shields.io/npm/v/agentmail-mcp)](https://www.npmjs.com/package/agentmail-mcp)
[![npm downloads](https://img.shields.io/npm/dw/agentmail-mcp)](https://www.npmjs.com/package/agentmail-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

Give any MCP-compatible AI agent its own email inbox. Send, receive, reply, and manage threaded email conversations — all through the [Model Context Protocol](https://modelcontextprotocol.io).

Built on [AgentMail](https://agentmail.to) — the email inbox API designed for autonomous AI agents. [YC S25](https://www.ycombinator.com/companies/agentmail).

## Why AgentMail?

Most email APIs are built for **sending** transactional emails. AgentMail is built for **two-way email** — giving AI agents their own inboxes to send, receive, read, reply, and manage threaded conversations autonomously.

| Feature | AgentMail | Traditional Email APIs |
|---|---|---|
| Dedicated agent inboxes | ✅ | ❌ |
| Send emails | ✅ | ✅ |
| Receive & read emails | ✅ | ❌ (or complex IMAP) |
| Threaded conversations | ✅ | ❌ |
| Reply & forward | ✅ | ❌ |
| Draft management | ✅ | ❌ |
| Webhooks on incoming mail | ✅ | ❌ |
| Built for AI agents | ✅ | ❌ |

## Quick Start

### 1. Get an API Key

Sign up at [agentmail.to](https://agentmail.to) and grab your API key.

### 2. Configure Your MCP Client

Add the following to your MCP client configuration:

<details>
<summary><strong>Claude Desktop</strong></summary>

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

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

Add to `.cursor/mcp.json` in your project root:

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
<summary><strong>VS Code (Copilot)</strong></summary>

Add to your VS Code `settings.json`:

```json
{
    "mcp": {
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
}
```

</details>

## Available Tools

The server exposes a comprehensive set of tools for full email lifecycle management:

### Inbox Management
- **`create_inbox`** — Create a new email inbox for your agent
- **`get_inbox`** — Get inbox details and settings
- **`update_inbox`** — Update inbox configuration
- **`list_inboxes`** — List all inboxes in your account

### Sending & Receiving
- **`send_message`** — Send an email from your agent's inbox
- **`get_message`** — Read a specific email message
- **`list_messages`** — List messages in an inbox
- **`reply_to_message`** — Reply to an email
- **`forward_message`** — Forward an email

### Thread Management
- **`get_thread`** — Get a full email thread/conversation
- **`list_threads`** — List all threads in an inbox
- **`update_thread`** — Update thread metadata
- **`delete_thread`** — Delete a thread

### Draft Management
- **`create_draft`** — Create a draft email
- **`get_draft`** — Get a draft
- **`list_drafts`** — List all drafts
- **`update_draft`** — Update a draft
- **`send_draft`** — Send a draft

## Tool Selection

By default, all available tools are loaded. You can selectively enable specific tools using the `--tools` argument to reduce context window usage:

```json
{
    "mcpServers": {
        "AgentMail": {
            "command": "npx",
            "args": ["-y", "agentmail-mcp", "--tools", "send_message,get_message,reply_to_message,list_threads"],
            "env": {
                "AGENTMAIL_API_KEY": "YOUR_API_KEY"
            }
        }
    }
}
```

## Example Use Cases

- **Customer support agent** — Auto-triage and respond to support emails
- **Sales outreach agent** — Send personalized cold emails and handle replies
- **Scheduling assistant** — Coordinate meetings via email threads
- **Legal intake agent** — Receive and process legal inquiries
- **Recruiting coordinator** — Screen candidates and manage interview scheduling
- **Receipt parser** — Process emailed receipts and invoices automatically

## More Resources

- 📖 [AgentMail Documentation](https://docs.agentmail.to)
- 🐍 [Python SDK](https://github.com/agentmail-to/agentmail-python)
- 📦 [Node.js SDK](https://github.com/agentmail-to/agentmail-node)
- 🔗 [LangChain Integration](https://github.com/agentmail-to/langchain-agentmail)
- 💡 [Example Agents](https://github.com/agentmail-to/agentmail-examples)
- 🌐 [Website](https://agentmail.to)

## License

MIT
