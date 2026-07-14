# Migration

New clients should connect directly to `https://mcp.agentmail.to/mcp`. Existing `agentmail-mcp` npm and PyPI commands continue to work through thin stdio bridges.

The former local npm implementation is preserved by the `legacy-local-v0.2.2` tag and release. Duplicate hosted and marketplace repositories become permanent archived pointers only after production and marketplace cutover gates pass.

Old human-facing pages redirect to the canonical documentation. Old MCP protocol hostnames may temporarily route to the same runtime, but authenticated POST requests must not be redirected blindly across origins.

The historical repositories `agentmail-manufact-mcp` and `agentmail-smithery-mcp` are retained for links and audit history. They are not maintained implementations after cutover.

See `migration-surfaces.yaml` for controlled and third-party status. Immutable commits, forks, mirrors, and caches are recorded rather than erased.
