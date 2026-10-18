#!/usr/bin/env bash
# Offline checks that need no secrets: build every edge function, typecheck the
# MCP server and approval page, and syntax-check the autopilot. Used by CI and deploy.sh.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "-- edge functions: unit tests"
node --test "functions/test/*.test.ts" > /tmp/plantforge-tests.log 2>&1 || { cat /tmp/plantforge-tests.log; exit 1; }
grep -E "^ℹ (tests|pass|fail) " /tmp/plantforge-tests.log | tr '\n' ' '; echo

echo "-- edge functions: build + Deno typecheck"
node scripts/build-functions.mjs > /dev/null
npx -y deno@2 check --no-lock --quiet functions/dist/*.ts

echo "-- mcp-server"
(cd mcp-server && { [ -d node_modules ] || npm ci --silent; } && npx tsc --noEmit -p .)

echo "-- approval-page"
(cd approval-page && { [ -d node_modules ] || npm ci --silent; } && npx tsc --noEmit -p .)

echo "-- autopilot / scripts"
node --check autopilot/autopilot.mjs
node --check scripts/simulate-plant.mjs
node --check scripts/smoke-live.mjs
node --check scripts/test-db-rules.mjs

echo "checks passed"
