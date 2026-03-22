# AgentMail MCP Server

Give your AI agent its own email address. MCP server for [AgentMail](https://agentmail.to).

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

## Available Tools

| Tool | Description |
|------|-------------|
| `create_inbox` | Create a new email inbox for an agent |
| `list_inboxes` | List all inboxes in your account |
| `get_inbox` | Get details of a specific inbox |
| `delete_inbox` | Delete an inbox |
| `send_message` | Send an email from an agent inbox |
| `reply_to_message` | Reply to an email in a thread |
| `forward_message` | Forward an email |
| `update_message` | Update message labels or status |
| `list_threads` | List email threads in an inbox |
| `get_thread` | Get a full email thread with messages |
| `get_attachment` | Download an email attachment |

## Quick Example

Create an inbox for your agent and send an email — in 10 lines:

```python
from agentmail import AgentMailClient

client = AgentMailClient(api_key="YOUR_API_KEY")

# Create a dedicated inbox for your agent
inbox = client.create_inbox(display_name="Sales Agent")
print(f"Agent email: {inbox.inbox_id}")

# Send an email
client.send_message(
    inbox_id=inbox.inbox_id,
    to="prospect@example.com",
    subject="Following up on our conversation",
    text="Hi, I wanted to follow up on our earlier discussion..."
)
```

## Tool Selection

By default, all available tools are loaded. You can selectively enable specific tools using the `--tools` argument with a comma-separated list of tool names.

### Example

```json
{
    "mcpServers": {
        "AgentMail": {
            "command": "npx",
            "args": ["-y", "agentmail-mcp", "--tools", "create_inbox,send_message,reply_to_message,list_threads,get_thread"],
            "env": {
                "AGENTMAIL_API_KEY": "YOUR_API_KEY"
            }
        }
    }
}
```

## Links

- [AgentMail](https://agentmail.to) — Email infrastructure for AI agents
- [Documentation](https://docs.agentmail.to) — Full API reference
- [Python SDK](https://github.com/agentmail-to/agentmail-python) — Python client library
