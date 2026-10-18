#!/usr/bin/env bash
# Offline checks that need no secrets: build every edge function, typecheck the
# MCP server and approval page, and syntax-check the autopilot. Used by CI and deploy.sh.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "-- edge functions"
node scripts/build-functions.mjs > /dev/null

echo "-- mcp-server"
(cd mcp-server && { [ -d node_modules ] || npm ci --silent; } && npx tsc --noEmit -p .)

echo "-- approval-page"
(cd approval-page && { [ -d node_modules ] || npm ci --silent; } && npx tsc --noEmit -p .)

echo "-- autopilot / scripts"
node --check autopilot/autopilot.mjs
node --check scripts/simulate-plant.mjs

echo "checks passed"
