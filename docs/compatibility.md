# Compatibility

Direct Streamable HTTP is the primary integration. Use `https://mcp.agentmail.to/mcp` with OAuth or the server's currently supported per-request API-key header.

Use the npm bridge with existing Node configurations:

```sh
npx -y agentmail-mcp
```

Use the Python bridge with a normal install or isolated runner:

```sh
uvx agentmail-mcp
```

Both bridges are supported with no planned end of life. They discover tools dynamically, preserve structured MCP results and errors, and support stdio-only clients. New AgentMail tools ship in the hosted server, not in bridge releases.

The Python bridge stops its local await when a client cancels, but MCP Python SDK 1.28.1 does not expose a public outgoing request ID or cancellation handle, so it cannot explicitly forward `notifications/cancelled` upstream without unsupported internals. Track [issue #1410](https://github.com/modelcontextprotocol/python-sdk/issues/1410), [PR #2514](https://github.com/modelcontextprotocol/python-sdk/pull/2514), and the v2 `CallOptions.cancel_on_abandon` work in [PR #2838](https://github.com/modelcontextprotocol/python-sdk/pull/2838); reassess after a supporting release.

Exact-pinned historical package releases remain available. Future bridge retirement requires a separate RFC, evidence, a migration path, and public notice. Package names must never be deleted or surrendered.
