#!/bin/zsh

sudo chown -R vscode:vscode node_modules
# @qtmleap packages come from GitHub Packages, which wants a token even to
# read (bunfig.toml). The gh login mounted from the host carries one.
export GH_TOKEN="${GH_TOKEN:-$(gh auth token 2>/dev/null)}"
bun install --frozen-lockfile --ignore-scripts
bunx --bun biome migrate --write
bunx playwright install-deps chromium
# The mocks' stylesheet is generated and gitignored. Built once here so the
# mock-diff sidecar renders styled mocks from the first visit; `bun run
# mocks:css --watch` (or `mocks:serve`) keeps it current while editing.
bun run mocks:css
