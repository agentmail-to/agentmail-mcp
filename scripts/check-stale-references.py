#!/usr/bin/env python3
"""Reject stale AgentMail MCP product and discovery references."""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path


PATTERNS = {
    r"agentmail-manufact-mcp": "former hosted-source repository",
    r"agentmail-smithery-mcp": "former Smithery-source repository",
    r"@agentmail/mcp(?![-\w])": "nonexistent npm package",
    r"agentmail\.run\.tools": "retired Smithery deployment",
    r"server\.smithery\.ai/agentmail": "retired Registry endpoint",
    r"\b(?:11|17)[ -]tools?\b": "copied legacy tool count",
    r"\bManufact MCP\b": "deployment provider presented as a product",
}
ALLOWED = {
    "docs/migration.md",
    "docs/third-party-corrections.md",
    "migration-surfaces.yaml",
    "scripts/audit-public-surfaces.py",
}


def scan_text(text: str) -> list[str]:
    return [label for pattern, label in PATTERNS.items() if re.search(pattern, text, re.IGNORECASE)]


def tracked_files(root: Path) -> list[Path]:
    names = subprocess.check_output(["git", "-C", root, "ls-files", "-z"]).split(b"\0")
    return [root / name.decode() for name in names if name]


def scan(root: Path) -> list[str]:
    errors: list[str] = []
    for path in tracked_files(root):
        relative = path.relative_to(root).as_posix()
        if relative in ALLOWED or relative == "scripts/check-stale-references.py" or not path.is_file():
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        errors.extend(f"{relative}: {label}" for label in scan_text(text))
    return errors


def main() -> int:
    if "--self-test" in sys.argv:
        assert scan_text("install @agentmail/mcp") == ["nonexistent npm package"]
        assert scan_text("https://mcp.agentmail.to/mcp") == []
        print("stale-reference self-test passed")
        return 0

    root = Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()
    errors = scan(root)
    if errors:
        print("Stale AgentMail MCP references found:", file=sys.stderr)
        print("\n".join(f"- {error}" for error in errors), file=sys.stderr)
        return 1
    print("No unapproved stale AgentMail MCP references found")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
