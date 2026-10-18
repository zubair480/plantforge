# Maintenance backend (InsForge)

Base URL for every function: `https://nden3esm.us-west.insforge.app/functions/<slug>`
Tokens live in `.env.local` (never commit it, never put it in a browser).

## The flow

```
plant-ingest -> investigate-incident -> request-quotes -> (contractor replies) email-inbound
  -> request-approval -> approve-quote (human manager) -> create-payment -> Stripe webhook
  -> report-repair -> verify-recovery -> VERIFIED
```

The database itself refuses skipped steps. For example, it blocks paying before approval or approving an amount that differs from the quote.

## Functions

| Slug | Who calls it | Auth header | Body |
|---|---|---|---|
| `plant-ingest` | Ignition | `x-plant-token` | `{type: alarm_active\|alarm_cleared\|reading, asset_id, alarm_id, tags:{flow,run_cmd,fault}}` |
| `incident-status` | MCP | `x-agent-token` | `{action:"list_active"}`, `{action:"asset", asset_id}`, `{incident_id}`, `{action:"compare_quotes", incident_id}` |
| `investigate-incident` | MCP | `x-agent-token` | `{incident_id}` |
| `request-quotes` | MCP | `x-agent-token` | `{incident_id, technician_ids?, max?}` |
| `email-inbound` | Primitive webhook | `Primitive-Signature` | Primitive `email.received` event (agent token + `{from, subject, text}` works only while the secret `ALLOW_MANUAL_INBOUND=true`) |
| `request-approval` | MCP | `x-agent-token` | `{incident_id, quote_id}` |
| `approve-quote` | Manager page | manager's InsForge login (`Authorization: Bearer`) | `{quote_id, decision, amount_cents}` |
| `create-payment` | MCP or manager page | `x-agent-token` or manager login | `{approval_id}` |
| `report-repair` | MCP | `x-agent-token` | `{incident_id, report, photo_url?, submitted_by?}`. Also accepted after `VERIFICATION_FAILED`: the technician reworks the same paid job. |
| `verify-recovery` | MCP | `x-agent-token` | `{incident_id, window_seconds?}` |

Every response includes `incident.allowed_next_actions`. Errors look like `{error:{code, message, hint}}`.

## Edit and deploy

```bash
node scripts/build-functions.mjs
npx -y @insforge/cli functions deploy <slug> --file functions/dist/<slug>.ts
```

## Test without the factory

```bash
node scripts/simulate-plant.mjs alarm          # pump fails
node scripts/simulate-plant.mjs healthy 35     # after repair: fault cleared, flow normal
```

## Still to set up

1. **Primitive:** add the API key as `PRIMITIVE_API_KEY`. Point a webhook at `.../functions/email-inbound` and set its signing secret as `PRIMITIVE_WEBHOOK_SECRET`. Change the technician emails in `public.technicians` to real teammate inboxes.
2. **Stripe:** `npx -y @insforge/cli payments stripe config set` (test key). Then create one product with a $1.00 price and a $0.01 price, and set them as `STRIPE_PRICE_PER_DOLLAR` and `STRIPE_PRICE_PER_CENT`. Then run `payments stripe webhooks configure --environment test`.
3. **Manager:** sign in at the approval page with your email. The page shows your user ID and the exact SQL to make you a manager. Run that SQL with `npx -y @insforge/cli db query "..."`.

## Approval page

Live at https://nden3esm.insforge.site (source in `approval-page/`). Managers sign in with an email code, review the quote the agent picked, and approve or reject it. They then pay through Stripe Checkout. `request-approval` returns links to this page.

To redeploy:

```bash
npx -y @insforge/cli deployments deploy approval-page
```

## MCP server

The agent-facing tools live in `mcp-server/`. See `mcp-server/README.md` to run and deploy them to Manufact.
