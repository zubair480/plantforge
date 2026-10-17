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

Details: [BACKEND.md](BACKEND.md). Secrets live in `.env.local` and InsForge secrets, never in the repo.
