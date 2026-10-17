# PlantForge

Agent-facing industrial maintenance. When a machine breaks, any AI agent can take the incident from SCADA alarm to independently verified repair through one MCP server: diagnose, email contractors, get human approval, pay, and verify recovery from plant data.

Built at YC "Make Something Agents Want" (Oct 17-18, 2026).

```
Factory I/O -> CODESYS -> Ignition --alarm--> InsForge backend <--MCP-- Manufact <-- any agent (Claude, Armature evals, Blaxel autopilot)
                                                    |
                                Primitive (contractor email) · Approval page · Stripe (test payments) · Inkbox (urgent alerts)
```

## How one repair flows

`DETECTED -> DIAGNOSED -> QUOTES_REQUESTED -> QUOTE_RECEIVED -> APPROVAL_PENDING -> APPROVED -> PAID -> SCHEDULED -> REPAIR_REPORTED -> VERIFYING -> VERIFIED`

The database enforces every transition. Agents cannot skip approval, approvals must match the quote exactly, payments need an approved approval, and only plant readings can close an incident.

## Sponsors

| Sponsor | Role |
|---|---|
| InsForge | Postgres, edge functions, auth, hosting, AI gateway, Stripe integration |
| Manufact | Hosts the MCP server (11 tools) |
| Primitive | Contractor quote emails and parsed replies |
| Stripe | Approval-gated test-mode payments |
| Armature | Agent evals against the live MCP |
| Blaxel | Always-on autopilot agent in a sandbox |
| Inkbox | Urgent manager alerts |

## Repo map

| Path | What |
|---|---|
| `migrations/` | Schema, state machine, payment hooks |
| `functions/src/` | InsForge edge functions (build with `node scripts/build-functions.mjs`) |
| `mcp-server/` | mcp-use MCP server deployed on Manufact |
| `approval-page/` | Manager approval page (Vite) |
| `autopilot/` | Blaxel autopilot agent |
| `ignition/` | Ignition gateway script that pushes alarms |
| `evals/` | Armature eval scenarios |
| `scripts/simulate-plant.mjs` | Fake plant for demos without Ignition |

## Run it in the cloud

Everything except the physical plant software runs hosted:

| Piece | Where it runs | How to (re)deploy |
|---|---|---|
| Database + functions | InsForge | `bash scripts/deploy.sh` (or the `deploy` GitHub Action) |
| Approval page | InsForge hosting | same script |
| MCP server | Manufact | `bash scripts/deploy.sh --mcp` |
| Autopilot agent + plant simulator | Blaxel, or any container host | `docker build -t plant-autopilot autopilot` |
| Ignition / CODESYS / Factory I/O | The plant's own Windows machine | `ignition/gateway_events.py` |

**Demo with no laptop:** run the autopilot container with `PLANT_INGEST_TOKEN` set, then open:
- `GET /simulate/alarm`: the pump fails. The agent diagnoses it and emails the contractor by itself.
- `GET /simulate/healthy?secs=35`: after the repair, healthy readings let `verify_recovery` pass.
- `GET /`: the agent's recent actions.

**GitHub Action:** add the repo secret `INSFORGE_ACCESS_TOKEN` (InsForge dashboard → Profile → API Keys). Every push to `main` that touches `migrations/`, `functions/src/`, `approval-page/` or `scripts/` then deploys automatically. You can also run it by hand from the Actions tab.

All config is environment variables. See [.env.example](.env.example).

Details: [BACKEND.md](BACKEND.md). Secrets live in `.env.local` and InsForge secrets, never in the repo.
