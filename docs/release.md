# Release and rollback

## Reversible preparation

1. Build and test the hosted server and both bridge artifacts.
2. Compare the preview runtime contract with `mcp-manifest.json`.
3. Verify direct hosted, npm stdio, and PyPI stdio paths.
4. Prepare first-party documentation and discovery commits.

Record the Python bridge's current cancellation limitation from `docs/compatibility.md` in release notes until the MCP Python SDK exposes a supported upstream cancellation handle.

## Human-gated cutover

1. Repoint the existing production project to this repository and canary it.
2. Promote only after health, authentication-characterization, and tool-contract checks pass.
3. Publish npm, then PyPI, and smoke-test clean installs.
4. Publish first-party docs and discovery changes.
5. Repoint and authenticate a real call through Smithery.
6. Publish Registry metadata and retire the duplicate identity.

Do not archive duplicate repositories until the production rollback window and Smithery verification are complete.

## Rollback

Keep the previous production artifact deployable in the same project for at least 14 days. A server rollback restores that revision without restoring a duplicate canonical repository. Package releases are immutable: publish a fixed patch and advance the distribution tag instead of unpublishing.
