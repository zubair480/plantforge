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

**Demo with no laptop:** run the autopilot container with `PLANT_INGEST_TOKEN` and `SIMULATOR_KEY` set, then open:
- `GET /simulate/alarm?key=<SIMULATOR_KEY>`: the pump fails. The agent diagnoses it and emails the contractor by itself.
- `GET /simulate/healthy?secs=35&key=<SIMULATOR_KEY>`: after the repair, healthy readings let `verify_recovery` pass.
- `GET /`: the agent's recent actions. `GET /healthz`: the liveness check the container uses.

The simulator is off unless `SIMULATOR_KEY` is set, because a fake alarm makes the agent email real contractors.

**GitHub Action:** every push and pull request runs `scripts/check.sh` (builds every function, typechecks the MCP server and approval page). Pushes to `main` then deploy, if the repo has the secret `INSFORGE_ACCESS_TOKEN` (InsForge dashboard → Profile → API Keys). Add `AGENT_API_TOKEN` too to get a post-deploy health check. `scripts/deploy.sh` stops at the first failure, so a broken migration never ships new functions.

## Security model

| Layer | Control |
|---|---|
| Database | Incident transitions, approval amounts and payment amounts are enforced by triggers. Only `public.managers` can read data, and all writes go through edge functions. |
| Edge functions | Agents authenticate with `x-agent-token`, Ignition with `x-plant-token`, managers with their InsForge login, and Primitive with a signed webhook. Agents get a 403 on `approve-quote`. |
| MCP server | Set `MCP_ACCESS_TOKEN` to require `Authorization: Bearer …` from every client. |
| Autopilot | The simulator is disabled without `SIMULATOR_KEY`. `/healthz` lets the host restart a stuck agent. |

## Production checklist

1. **Primitive:** set `PRIMITIVE_API_KEY` and `PRIMITIVE_WEBHOOK_SECRET`, point the webhook at `/functions/email-inbound`, then set `ALLOW_MANUAL_INBOUND=false`. Without that last step, anyone holding the agent token can post a fake contractor quote.
2. **MCP server:** set `MCP_ACCESS_TOKEN` on Manufact and redeploy (`bash scripts/deploy.sh --mcp`). Give the token to the autopilot and to every agent client.
3. **Stripe:** use live keys only after a test run. The approval and payment triggers are the same in test and live mode.
4. **Managers:** add each approver to `public.managers` with a sensible `spend_limit_cents`.
5. **Rotate** `AGENT_API_TOKEN`, `PLANT_INGEST_TOKEN` and the InsForge project API key if they were ever shared in chat or on screen.

All config is environment variables. See [.env.example](.env.example).

Details: [BACKEND.md](BACKEND.md). Secrets live in `.env.local` and InsForge secrets, never in the repo.
