# Release and rollback

## Reversible preparation

1. Build and test the hosted server and both bridge artifacts.
2. Compare the preview runtime contract with `mcp-manifest.json`.
3. Verify direct hosted, npm stdio, and PyPI stdio paths.
4. Prepare first-party documentation and discovery commits.

Record the Python bridge's current cancellation limitation from `docs/compatibility.md` in release notes until the MCP Python SDK exposes a supported upstream cancellation handle.

## npm trusted publishing

The `Publish npm bridge` workflow publishes `packages/npm-stdio-bridge` through npm's GitHub Actions trusted publishing flow. It requires no long-lived npm token. Before the first run, a human package owner must configure the trusted publisher for `agentmail-mcp` with:

- organization or user: `agentmail-to`
- repository: `agentmail-mcp`
- workflow filename: `publish-npm.yml`
- allowed action: publish

Configure it at <https://www.npmjs.com/package/agentmail-mcp/access>, or with npm CLI 11.15.0 or newer:

```sh
npm trust github agentmail-mcp --file publish-npm.yml --repo agentmail-to/agentmail-mcp --allow-publish -y
```

After that external setup is confirmed, open the [Publish npm bridge workflow](https://github.com/agentmail-to/agentmail-mcp/actions/workflows/publish-npm.yml), choose **Run workflow** on the default branch, and enter the exact version from `packages/npm-stdio-bridge/package.json`. The workflow verifies that version, runs the bridge and boundary tests, performs an npm publish dry run, and then publishes with an OIDC identity. After it succeeds, smoke-test `npx -y agentmail-mcp@<version>` in a clean environment before advancing the cutover.

## Human-gated cutover

1. Repoint the existing production project to this repository and canary it.
2. Promote only after health, authentication-characterization, and tool-contract checks pass.
3. Publish npm with the manual trusted-publishing workflow above, then publish PyPI, and smoke-test clean installs.
4. Publish first-party docs and discovery changes.
5. Repoint and authenticate a real call through Smithery.
6. Publish Registry metadata and retire the duplicate identity.

Do not archive duplicate repositories until the production rollback window and Smithery verification are complete.

## PyPI trusted publishing

Before the first run, an AgentMail administrator must confirm project ownership and recovery access, enable 2FA, and add this repository's `publish-pypi.yml` workflow as a [PyPI Trusted Publisher](https://pypi.org/manage/project/agentmail-mcp/settings/publishing/). After npm `1.0.0` is healthy, dispatch the reviewed commit without adding an API token:

```sh
gh workflow run publish-pypi.yml --ref main
```

After it succeeds, verify the registry artifact with `uvx --refresh --from agentmail-mcp==1.0.0 agentmail-mcp --help` before announcing support.

## Rollback

Keep the previous production artifact deployable in the same project for at least 14 days. A server rollback restores that revision without restoring a duplicate canonical repository. Package releases are immutable: publish a fixed patch and advance the distribution tag instead of unpublishing.
