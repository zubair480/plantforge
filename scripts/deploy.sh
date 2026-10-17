#!/usr/bin/env bash
# Deploy everything to the cloud in one command. Works on a laptop or in CI.
#   bash scripts/deploy.sh            # database + functions + approval page
#   bash scripts/deploy.sh --mcp      # also redeploy the MCP server to Manufact
#
# Auth: a logged-in InsForge CLI, or INSFORGE_ACCESS_TOKEN + INSFORGE_PROJECT_ID (CI).
set -euo pipefail
cd "$(dirname "$0")/.."
cli() { npx -y @insforge/cli "$@"; }

if [ ! -f .insforge/project.json ]; then
  : "${INSFORGE_PROJECT_ID:?set INSFORGE_PROJECT_ID (or run: npx -y @insforge/cli link)}"
  cli link --project-id "$INSFORGE_PROJECT_ID" -y
fi

echo "== Database migrations"
cli db migrations up --all || echo "(no pending migrations)"

echo "== Edge functions"
node scripts/build-functions.mjs
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

echo "Done. Smoke test: node mcp-server/scripts/smoke-test.mjs https://dark-forge-tma6f.run.mcp-use.com/mcp"
