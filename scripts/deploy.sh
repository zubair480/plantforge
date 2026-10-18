#!/usr/bin/env bash
# Deploy everything to the cloud in one command. Works on a laptop or in CI.
#   bash scripts/deploy.sh            # database + functions + approval page
#   bash scripts/deploy.sh --mcp      # also redeploy the MCP server to Manufact
#
# Auth: a logged-in InsForge CLI, or INSFORGE_ACCESS_TOKEN + INSFORGE_PROJECT_ID (CI).
# Stops at the first failure so a broken migration never ships new functions.
set -euo pipefail
cd "$(dirname "$0")/.."
cli() { npx -y @insforge/cli "$@"; }

if [ ! -f .insforge/project.json ]; then
  : "${INSFORGE_PROJECT_ID:?set INSFORGE_PROJECT_ID (or run: npx -y @insforge/cli link)}"
  cli link --project-id "$INSFORGE_PROJECT_ID" -y
fi

echo "== Checks"
bash scripts/check.sh

echo "== Database migrations"
if ! out="$(cli db migrations up --all 2>&1)"; then
  echo "$out"
  if echo "$out" | grep -qiE "no pending|up to date|nothing to (apply|migrate)"; then
    echo "(no pending migrations)"
  else
    echo "Migration failed; nothing else was deployed." >&2
    exit 1
  fi
else
  echo "$out" | tail -5
fi

echo "== Database rules (state machine, guard triggers, read access)"
node scripts/test-db-rules.mjs | tail -1

echo "== Edge functions"
for f in functions/dist/*.ts; do
  slug="$(basename "$f" .ts)"
  cli functions deploy "$slug" --file "$f" | tail -1
done

echo "== Approval page"
cli deployments deploy approval-page | tail -3

if [ "${1:-}" = "--mcp" ]; then
  echo "== MCP server (Manufact)"
  (cd mcp-server && npm ci && npx mcp-use deploy --json)
fi

echo "== Post-deploy smoke test"
if [ -n "${AGENT_API_TOKEN:-}" ] || [ -f .env.local ]; then
  node scripts/smoke-live.mjs
else
  echo "(set AGENT_API_TOKEN and PLANT_INGEST_TOKEN to run the live smoke test)"
fi

echo "Done. MCP smoke test: node mcp-server/scripts/smoke-test.mjs https://dark-forge-tma6f.run.mcp-use.com/mcp"
