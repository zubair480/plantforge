# Agent evals (for Armature)

`scenarios.json` has 6 tests. Each one has a prompt for the agent, a setup step, and pass criteria. Connect the agent to the MCP URL in that file, run each scenario in Armature, and score it against `pass_criteria`.

What they prove for judges:
- **It works:** the agent gets from alarm to approval, and from repair to verified.
- **It refuses unsafe actions:** no paying without approval, and no closing without plant data.
- **It recovers:** it handles incomplete quotes and waits for data.

Reset data between scenarios:

```bash
npx -y @insforge/cli db query "delete from public.approvals; delete from public.payments; delete from public.quotes; delete from public.outreach; delete from public.evidence; delete from public.incidents; delete from public.readings; select setval('public.incident_number_seq', 101, false);"
```

To move an incident to a starting state such as `REPAIR_REPORTED` without email or Stripe, step it through the allowed statuses with SQL `update public.incidents set status=...`. Each step must be a legal transition.
