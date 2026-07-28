#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
dist=${1:-"$tmp/dist"}

cd "$root"
# Read the expected version from pyproject rather than pinning it, so a release
# bump doesn't fail its own smoke test.
expected=$(sed -n 's/^version = "\(.*\)"/\1/p' pyproject.toml)
[ -n "$expected" ] || { echo "could not read version from pyproject.toml" >&2; exit 1; }
mkdir -p "$dist"
python -m build --outdir "$dist"
for artifact in "$dist"/*; do
    python -m venv "$tmp/venv"
    "$tmp/venv/bin/python" -m pip install -q "$artifact"
    "$tmp/venv/bin/python" -m pip check
    "$tmp/venv/bin/agentmail-mcp" --help >/dev/null
    EXPECTED="$expected" "$tmp/venv/bin/python" -c 'import os, importlib.metadata as m; assert m.version("agentmail-mcp") == os.environ["EXPECTED"], m.version("agentmail-mcp"); assert not any(r.lower().startswith(("agentmail ", "agentmail-toolkit")) for r in m.requires("agentmail-mcp"))'
    rm -rf "$tmp/venv"
done
