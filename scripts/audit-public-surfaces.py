#!/usr/bin/env python3
"""Report whether public AgentMail MCP discovery surfaces agree."""

from __future__ import annotations

import argparse
import json
import re
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
ENDPOINT = "https://mcp.agentmail.to/mcp"
SOURCE = "https://github.com/agentmail-to/agentmail-mcp"
REGISTRY = "https://registry.modelcontextprotocol.io/v0.1/servers?search="
NPM_LATEST = "https://registry.npmjs.org/agentmail-mcp/latest"
PYPI_LATEST = "https://pypi.org/pypi/agentmail-mcp/json"
CONTROLLED = {
    "MCP docs": "https://docs.agentmail.to/integrations/mcp",
    "agent onboarding": "https://docs.agentmail.to/agent-onboarding",
    "Google ADK docs": "https://docs.agentmail.to/integrations/google-adk",
    "Cursor builder": "https://agentmail.to/build/cursor",
    "Windsurf builder": "https://agentmail.to/build/windsurf",
    "llms.txt": "https://agentmail.to/llms.txt",
    "llms-full.txt": "https://agentmail.to/llms-full.txt",
    "integration manifest": "https://agentmail.to/.well-known/integrations.json",
    "MCP server card": "https://agentmail.to/.well-known/mcp/server-card.json",
    "plugin compatibility": "https://raw.githubusercontent.com/agentmail-to/agentmail-plugins/main/compatibility.json",
    "MCP skill": "https://raw.githubusercontent.com/agentmail-to/agentmail-skills/main/agentmail-mcp/SKILL.md",
}
STALE = (
    "agentmail-manufact-mcp",
    "agentmail-smithery-mcp",
    "@agentmail/mcp",
    "agentmail.run.tools",
    "server.smithery.ai/agentmail",
    "17 tools",
    "11 tools",
)


def fetch(url: str) -> tuple[int, bytes]:
    request = urllib.request.Request(url, headers={"User-Agent": "agentmail-mcp-surface-audit/1.0"})
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read()
    except (urllib.error.URLError, TimeoutError) as exc:
        return 0, str(exc).encode()


def registry(name: str) -> dict:
    status, body = fetch(REGISTRY + urllib.parse.quote(name, safe=""))
    if status != 200:
        raise RuntimeError(f"Registry returned HTTP {status} for {name}")
    return json.loads(body)


def repo_versions() -> dict[str, str]:
    # ponytail: reads pyproject's version line with a regex rather than tomllib, so this
    # runs on the 3.9 interpreters developers still have locally (CI pins 3.12). Switch to
    # tomllib if the version ever moves out of [project] or stops being a literal.
    pyproject = (ROOT / "python/stdio-bridge/pyproject.toml").read_text()
    match = re.search(r'(?m)^version = "([^"]+)"', pyproject)
    if not match:
        raise RuntimeError("could not read version from python/stdio-bridge/pyproject.toml")
    return {
        "npm": json.loads((ROOT / "packages/npm-stdio-bridge/package.json").read_text())["version"],
        "PyPI": match.group(1),
    }


def unreleased() -> list[str]:
    """Flag a bridge whose merged version was never published.

    agentmail-mcp 1.0.1 fixed a silent-startup bug on 2026-07-21 and sat on main
    unpublished for a week while npm kept serving the broken 1.0.0, because both
    publish workflows are workflow_dispatch and nothing watched the gap.
    """
    problems: list[str] = []
    repo = repo_versions()
    for name, url, workflow in (
        ("npm", NPM_LATEST, "Publish npm bridge"),
        ("PyPI", PYPI_LATEST, "Publish PyPI"),
    ):
        status, body = fetch(url)
        if status != 200:
            problems.append(f"{name} returned HTTP {status}")
            continue
        payload = json.loads(body)
        latest = payload["version"] if name == "npm" else payload["info"]["version"]
        if latest != repo[name]:
            problems.append(
                f"{name} publishes {latest} but the repo ships {repo[name]}"
                f" — run the '{workflow}' workflow"
            )
    return problems


def audit() -> list[str]:
    problems: list[str] = []
    problems.extend(unreleased())
    endpoint_status, _ = fetch(ENDPOINT)
    if endpoint_status not in {200, 401, 405}:
        problems.append(f"canonical endpoint returned HTTP {endpoint_status}")

    responses = {name: fetch(url) for name, url in CONTROLLED.items()}
    for name, (status, body) in responses.items():
        text = body.decode("utf-8", "replace")
        if status != 200:
            problems.append(f"{name} returned HTTP {status}")
            continue
        for stale in STALE:
            if stale.lower() in text.lower():
                problems.append(f"{name} contains stale reference: {stale}")

    status, docs = responses["MCP docs"]
    text = docs.decode("utf-8", "replace")
    if status != 200 or ENDPOINT not in text:
        problems.append("published MCP docs do not advertise the canonical endpoint")
    if SOURCE not in text:
        problems.append("published MCP docs do not advertise the canonical source")

    try:
        canonical = registry("to.agentmail/agentmail")
    except RuntimeError as exc:
        problems.append(str(exc))
    else:
        entries = canonical.get("servers", [])
        if len(entries) != 1:
            problems.append("canonical Registry identity is missing or ambiguous")
        elif entries[0]["server"].get("remotes", [{}])[0].get("url") != ENDPOINT:
            problems.append("canonical Registry identity advertises a different endpoint")

    try:
        legacy = registry("ai.smithery/agentmail")
    except RuntimeError as exc:
        problems.append(str(exc))
    else:
        if any(item.get("_meta", {}).get("io.modelcontextprotocol.registry/official", {}).get("status") == "active" for item in legacy.get("servers", [])):
            problems.append("legacy Smithery Registry identity is still active")
    return problems


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--strict", action="store_true", help="fail when a public surface still needs migration")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        assert urllib.parse.quote("to.agentmail/agentmail", safe="") == "to.agentmail%2Fagentmail"
        assert "11 tools" in STALE
        versions = repo_versions()
        assert set(versions) == {"npm", "PyPI"}, versions
        assert all(re.fullmatch(r"\d+\.\d+\.\d+", value) for value in versions.values()), versions
        print("public-surface audit self-test passed")
        return 0
    problems = audit()
    if problems:
        print("\n".join(f"- {problem}" for problem in problems))
        return int(args.strict)
    print("Public AgentMail MCP surfaces agree")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
