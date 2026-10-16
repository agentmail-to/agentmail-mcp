# Release and rollback

This document is the canonical release procedure for the hosted AgentMail MCP
server and every first-party surface that distributes or documents its public
contract. Do not infer downstream work from a particular release number or tool
list. Use the generated `mcp-manifest.json` diff to decide what must ship.

## Classify the change

Regenerate the manifest before release work:

```sh
pnpm generate:manifest
git diff -- mcp-manifest.json
```

An **implementation-only change** leaves the generated manifest, authentication
behavior, permissions, and documented workflows unchanged. Deploy and verify the
server, but do not create an artificial skills or plugin release.

A **public-contract change** changes any tool name, input or output schema,
description, annotation, authentication requirement, permission, endpoint, or
user-visible workflow. It requires the downstream procedure below. A manifest
digest change without a tool-name change still requires review: schema,
description, or annotation changes can invalidate agent instructions.

When classification is uncertain, treat the change as a public-contract change.

## Reversible preparation

1. Build and test the hosted server and both bridge artifacts.
2. Compare the preview runtime contract with `mcp-manifest.json`.
3. Verify direct hosted, npm stdio, and PyPI stdio paths.
4. For a public-contract change, prepare coordinated pull requests in
   [`agentmail-skills`](https://github.com/agentmail-to/agentmail-skills),
   [`agentmail-plugins`](https://github.com/agentmail-to/agentmail-plugins), and
   [`agentmail-docs`](https://github.com/agentmail-to/agentmail-docs).

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

After that external setup is confirmed, the workflow publishes automatically when a version bump to `packages/npm-stdio-bridge/package.json` merges to `main`. The merged bump is the release intent, and it was already reviewed in the PR. The workflow runs the bridge and boundary tests, performs an npm publish dry run, publishes with an OIDC identity, and then smoke-tests `npx -y agentmail-mcp@<version>` from a clean cache — asserting the entrypoint reaches its own argument check, because 1.0.0 exited 0 with no output through the bin symlink that `npx` uses. A push that edits `package.json` without changing the version is a no-op rather than a failure.

To publish out of band, open the [Publish npm bridge workflow](https://github.com/agentmail-to/agentmail-mcp/actions/workflows/publish-npm.yml), choose **Run workflow** on the default branch, and enter the exact version from `packages/npm-stdio-bridge/package.json`; the workflow refuses to run if the two disagree.

The daily `Public surfaces` audit backstops all of this: it fails when npm's or PyPI's `latest` disagrees with the version in the repo, catching a failed publish or a bridge that was bumped but never released.

## Human-gated cutover

1. Repoint the existing production project to this repository and canary it.
2. Promote only after health, authentication-characterization, and tool-contract checks pass.
3. Merge the npm bridge version bump to publish it, then publish PyPI with its manual workflow, and smoke-test clean installs.
4. Complete the first-party downstream release below.
5. Repoint and authenticate a real call through Smithery.
6. Publish Registry metadata and retire the duplicate identity.

Do not archive duplicate repositories until the production rollback window and Smithery verification are complete.

## First-party downstream release

Run this section for every public-contract change. The order is intentional:
canonical contract, canonical skills, generated plugin packages, documentation,
then reviewed marketplaces.

### 1. Verify the production contract

Deploy the hosted server and confirm that its initialized tool catalog matches
the committed `mcp-manifest.json`. Exercise authentication and error handling for
every affected authorization mode. Verify tool annotations as well as schemas;
clients use annotations to decide which calls require confirmation.

Do not publish downstream instructions for a contract that is only present on a
preview deployment.

### 2. Synchronize canonical skills

From an `agentmail-skills` checkout, with this repository checked out locally:

```sh
python3 scripts/skills.py sync --backend /path/to/agentmail-mcp
python3 scripts/skills.py validate
python3 scripts/skills.py build --check
python3 -m unittest discover -s tests -p 'test_*.py'
```

Review every MCP-facing skill when the manifest digest changes, even when the
tool-name set is unchanged. Merge the skills change before exporting the plugin.
The skills repository is the only source for skill prose; generated copies must
not be edited in the plugin repository.

### 3. Build and release the cross-client plugin

Export the canonical skills into an `agentmail-plugins` checkout:

```sh
python3 scripts/skills.py build --target /path/to/agentmail-plugins
```

Then follow the plugin repository's `docs/release.md`. That procedure owns
manifest versioning, changelog and compatibility updates, packaging validation,
client upgrade tests, and the Cursor review gate. A public-contract change is not
complete merely because the plugin commit reached `main`.

### 4. Update first-party documentation

In `agentmail-docs`, refresh the vendored manifest and generated catalog only
after the production contract is live:

```sh
python3 scripts/generate_mcp_tool_catalog.py --fetch
```

Update authentication, permissions, migration guidance, and workflows affected
by the change. Keep plugin OAuth instructions separate from API-key instructions
for standalone SDK, CLI, and manually configured MCP clients. Run the Fern check
before merging.

### 5. Read-only client acceptance

Test a clean install and an upgrade of the previously published plugin in Claude
Code, Codex, and Cursor. Start a new session or reload plugins, complete OAuth,
and exercise representative read-only tools from every changed capability. Also
inspect the advertised tool names and annotations.

Do not create inboxes, send mail, delete data, or invoke account-connection tools
during release acceptance. If a changed capability has no read-only operation,
verify discovery and schema exposure without invoking it.

Record the tested plugin commit, client versions, and result in the release pull
request or release issue. A clean-install-only test is insufficient because it
does not verify the existing-user upgrade path.

### 6. Marketplace completion

- **Claude Code:** change the plugin version whenever packaged content changes.
  Verify an existing installation with
  `claude plugin update agentmail@agentmail`, then apply it with
  `/reload-plugins` or a new session.
- **Codex:** refresh the Git marketplace with
  `codex plugin marketplace upgrade agentmail`, then verify the installed plugin
  in a new session.
- **Cursor:** update the existing AgentMail public listing to the released plugin
  commit. Do not create a replacement listing. Every public update is reviewed,
  so wait for approval once submitted and do not resubmit an unchanged revision.
  After approval, run `python3 scripts/check_cursor_marketplace.py` in the plugin
  repository to confirm the live commit, description, and complete skill set.

The release is complete only when required reviews are approved, public listing
checks pass, documentation is live, and the read-only client acceptance record is
attached to the release.

## PyPI trusted publishing

Before the first run, an AgentMail administrator must confirm project ownership and recovery access, enable 2FA, and add this repository's `publish-pypi.yml` workflow as a [PyPI Trusted Publisher](https://pypi.org/manage/project/agentmail-mcp/settings/publishing/). No API token is needed.

After that, the workflow publishes automatically when a version bump to `python/stdio-bridge/pyproject.toml` merges to `main`. It builds both distributions, installs each into a clean virtualenv, runs the `agentmail-mcp` console script, and checks the installed metadata against the version in `pyproject.toml` before anything reaches PyPI. A push that edits `pyproject.toml` without changing the version skips publishing rather than failing on a rejected re-upload.

To publish out of band, dispatch the reviewed commit:

```sh
gh workflow run publish-pypi.yml --ref main
```

After it succeeds, verify the registry artifact with `uvx --refresh --from agentmail-mcp==<version> agentmail-mcp --help` before announcing support.

## Rollback

Keep the previous production artifact deployable in the same project for at least 14 days. A server rollback restores that revision without restoring a duplicate canonical repository. Package releases are immutable: publish a fixed patch and advance the distribution tag instead of unpublishing.
