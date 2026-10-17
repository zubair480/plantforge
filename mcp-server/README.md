# Plant Maintenance MCP server (mcp-use / Manufact)

10 tools for AI agents. Each tool calls one InsForge edge function (see `../BACKEND.md`).

| Tool | What it does |
|---|---|
| `get_active_incidents` | List open incidents |
| `get_asset_context` | Asset details, latest readings, history |
| `investigate_incident` | Diagnose and pick the trade to send |
| `request_technician_quotes` | Email matching contractors |
| `compare_quotes` | Rank quotes and recommend one |
| `request_manager_approval` | Ask a human manager (the agent cannot approve) |
| `create_authorized_payment` | Stripe test checkout, only after approval |
| `get_repair_status` | Full incident state and timeline |
| `report_repair` | Record the technician's report |
| `verify_recovery` | Check plant readings; only this closes the incident |

## Run locally

`.env` needs `INSFORGE_FUNCTIONS_URL` and `AGENT_API_TOKEN` (copy them from `../.env.local`).

```bash
npm run dev
```

The inspector is at http://localhost:3000/mcp/inspector.

Quick test from a terminal:

```bash
node scripts/smoke-test.mjs http://localhost:3000/mcp get_active_incidents
```

## Deploy to Manufact

```bash
npx mcp-use login
```

```bash
npx mcp-use deploy --no-github --env-file .env
```

Live URL: `https://dark-forge-tma6f.run.mcp-use.com/mcp` (redeploy with `npx mcp-use deploy`). Add it in Claude as a custom connector, or in any MCP client.

Note: the hosted URL is public. Anyone with it can call the tools, but the backend still enforces every rule: no approvals by agents, no payment without approval, and no closing without plant data. Before going beyond the demo, add OAuth (mcp-use supports it).
