#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

cd "$root"
python -m build --outdir "$tmp/dist"
for artifact in "$tmp"/dist/*; do
    python -m venv "$tmp/venv"
    "$tmp/venv/bin/python" -m pip install -q "$artifact"
    "$tmp/venv/bin/python" -m pip check
    "$tmp/venv/bin/agentmail-mcp" --help >/dev/null
    "$tmp/venv/bin/python" -c 'import importlib.metadata as m; assert m.version("agentmail-mcp") == "1.0.0"; assert not any(r.lower().startswith(("agentmail ", "agentmail-toolkit")) for r in m.requires("agentmail-mcp"))'
    rm -rf "$tmp/venv"
done
