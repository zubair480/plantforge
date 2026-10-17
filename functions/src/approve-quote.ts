// Manager approval (called from the approval page with the manager's login).
// Body: { "quote_id": "...", "decision": "approved" | "rejected", "amount_cents": 18000 }
// The amount must equal the quote exactly and be within the manager's spend limit.
// APPROVAL_PENDING -> APPROVED, or back to QUOTE_RECEIVED when rejected.

import { adminDb, dollars, fail, getManager, handler, json, readJson, transition, withNext } from './_shared.ts';

export default handler(async (req) => {
  if (req.headers.get('x-agent-token')) {
    return fail(403, 'HUMAN_APPROVAL_REQUIRED', 'agents cannot approve spend',
      'Call request_manager_approval and wait for a human manager.');
  }
  const auth = await getManager(req);
  if (auth.error) return auth.error;
  const { user, manager } = auth;

  const { quote_id, decision, amount_cents, scope } = await readJson(req);
  if (!quote_id || !['approved', 'rejected'].includes(decision)) {
    return fail(400, 'MISSING_FIELDS', 'quote_id and decision (approved|rejected) are required');
  }

  const db = adminDb();
  const { data: quote } = await db.from('quotes').select('*').eq('id', quote_id).maybeSingle();
  if (!quote) return fail(404, 'QUOTE_NOT_FOUND', 'quote not found');
  if (quote.status !== 'selected') return fail(409, 'QUOTE_NOT_SELECTED', 'this quote is not awaiting approval');

  const { data: incident } = await db.from('incidents').select('*').eq('id', quote.incident_id).single();
  if (incident.status !== 'APPROVAL_PENDING') {
    return fail(409, 'INVALID_STATE', `incident is ${incident.status}, not APPROVAL_PENDING`);
  }

  if (decision === 'approved') {
    if (Number(amount_cents) !== quote.amount_cents) {
      return fail(422, 'AMOUNT_MISMATCH',
        `approved amount ${dollars(Number(amount_cents))} does not match quote ${dollars(quote.amount_cents)}`);
    }
    if (quote.amount_cents > manager.spend_limit_cents) {
      return fail(403, 'OVER_SPEND_LIMIT',
        `${dollars(quote.amount_cents)} exceeds your limit of ${dollars(manager.spend_limit_cents)}`,
        'Escalate to a manager with a higher limit.');
    }
  }

  const { data: approval, error } = await db.from('approvals').insert([{
    incident_id: incident.id,
    quote_id: quote.id,
    approver_id: user.id,
    decision,
    approved_amount_cents: quote.amount_cents,
    approved_scope: scope ?? quote.scope,
  }]).select();
  if (error) return fail(422, 'APPROVAL_REJECTED_BY_DB', error.message);

  const who = manager.display_name ?? user.email ?? user.id;
  let updated;
  if (decision === 'approved') {
    updated = await transition(incident.id, 'APPROVAL_PENDING', 'APPROVED', 'manager',
      `${who} approved ${dollars(quote.amount_cents)}`);
  } else {
    await db.from('quotes').update({ status: 'rejected' }).eq('id', quote.id);
    updated = await transition(incident.id, 'APPROVAL_PENDING', 'QUOTE_RECEIVED', 'manager',
      `${who} rejected the quote`);
  }

  return json({ ok: true, approval: approval[0], incident: withNext(updated) });
});
