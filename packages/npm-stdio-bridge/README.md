# agentmail-mcp

`agentmail-mcp` is the supported stdio compatibility bridge for the canonical hosted AgentMail MCP server at `https://mcp.agentmail.to/mcp`. It loads tools and schemas from that server at runtime; it does not contain a separate AgentMail tool implementation.

Prefer connecting an MCP client directly to the hosted endpoint when it supports Streamable HTTP. For stdio-only clients:

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

To expose only selected remote tools, add `"--tools", "list_inboxes,send_message"` to `args`. The API key is sent to the hosted server as `x-api-key` and is never written to stdout.

## Sending local attachments

Start the bridge with `--file-root /absolute/path/to/project` to let attachment-capable tools accept a local `path` in addition to base64 `content` or a public `url`:

```json
{
  "mcpServers": {
    "agentmail": {
      "command": "npx",
      "args": ["-y", "agentmail-mcp", "--file-root", "/absolute/path/to/project"],
      "env": { "AGENTMAIL_API_KEY": "your-api-key" }
    }
  }
}
```

Then an agent can send a file without placing its bytes in the tool call:

```json
{
  "inboxId": "sender@agentmail.to",
  "to": ["recipient@example.com"],
  "subject": "Document",
  "attachments": [
    {
      "path": "documents/report.pdf",
      "contentType": "application/pdf"
    }
  ]
}
```

The bridge reads and base64-encodes the file locally, then forwards the standard AgentMail tool call. This keeps file bytes out of the model's tool arguments. Paths may be absolute or relative, but must resolve inside the configured file root; symlinks cannot escape it. Hidden files and directories (including `.env`, `.git`, and `.npmrc`) are denied. Local attachments have a 6 MiB combined decoded-size limit. Without `--file-root`, the bridge exposes the hosted tool contract unchanged and cannot read local files.

Choose the narrowest directory that contains the files you intend to attach. Do not use your home directory or a project directory containing secrets. `--file-root` limits what this bridge can read; it does not sandbox an agent that has access to other filesystem or shell tools.

See the [AgentMail MCP documentation](https://docs.agentmail.to/integrations/mcp) for direct connection and migration guidance.
