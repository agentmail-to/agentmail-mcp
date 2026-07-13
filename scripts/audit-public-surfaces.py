#!/usr/bin/env python3
"""Report whether public AgentMail MCP discovery surfaces agree."""

from __future__ import annotations

import argparse
import json
import urllib.error
import urllib.parse
import urllib.request


ENDPOINT = "https://mcp.agentmail.to/mcp"
SOURCE = "https://github.com/agentmail-to/agentmail-mcp"
REGISTRY = "https://registry.modelcontextprotocol.io/v0.1/servers?search="
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


def registry(name: str) -> dict:
    status, body = fetch(REGISTRY + urllib.parse.quote(name, safe=""))
    if status != 200:
        raise RuntimeError(f"Registry returned HTTP {status} for {name}")
    return json.loads(body)


def audit() -> list[str]:
    problems: list[str] = []
    endpoint_status, _ = fetch(ENDPOINT)
    if endpoint_status not in {200, 401, 405}:
        problems.append(f"canonical endpoint returned HTTP {endpoint_status}")

    for name, url in CONTROLLED.items():
        status, body = fetch(url)
        text = body.decode("utf-8", "replace")
        if status != 200:
            problems.append(f"{name} returned HTTP {status}")
            continue
        for stale in STALE:
            if stale.lower() in text.lower():
                problems.append(f"{name} contains stale reference: {stale}")

    status, docs = fetch(CONTROLLED["MCP docs"])
    text = docs.decode("utf-8", "replace")
    if status != 200 or ENDPOINT not in text:
        problems.append("published MCP docs do not advertise the canonical endpoint")
    if SOURCE not in text:
        problems.append("published MCP docs do not advertise the canonical source")

    canonical = registry("to.agentmail/agentmail")
    entries = canonical.get("servers", [])
    if len(entries) != 1:
        problems.append("canonical Registry identity is missing or ambiguous")
    elif entries[0]["server"].get("remotes", [{}])[0].get("url") != ENDPOINT:
        problems.append("canonical Registry identity advertises a different endpoint")

    legacy = registry("ai.smithery/agentmail")
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
