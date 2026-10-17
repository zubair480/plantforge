// MCP tool: create_authorized_payment(approval_id)
// Creates a Stripe Checkout (test mode) for exactly the approved amount.
// Only after a human approval exists. InsForge creates Checkout with a user
// token, so the session is created with the signed-in manager's login; an
// agent call checks everything and returns the page where the manager pays.
// One payment per approval (idempotent). The Stripe webhook trigger in the
// database marks it paid and moves APPROVED -> PAID -> SCHEDULED.
//
// Dynamic amounts use a fixed $1.00 (or $0.01) Price with quantity = amount,
// because InsForge Checkout takes catalog Price IDs.

import { adminDb, dollars, fail, getManager, handler, isAgent, json, readJson, withNext } from './_shared.ts';

export default handler(async (req) => {
  const agent = isAgent(req);
  let manager: Awaited<ReturnType<typeof getManager>> | null = null;
  if (!agent) {
    manager = await getManager(req);
    if (manager.error) return manager.error;
  }

  const { approval_id, success_url, cancel_url } = await readJson(req);
  if (!approval_id) return fail(400, 'MISSING_APPROVAL_ID', 'approval_id is required');

  const db = adminDb();
  const { data: approval } = await db.from('approvals').select('*').eq('id', approval_id).maybeSingle();
  if (!approval) {
    return fail(404, 'APPROVAL_NOT_FOUND', 'no such approval',
      'Payments require a human approval. Call request_manager_approval first.');
  }
  if (approval.decision !== 'approved') {
    return fail(403, 'NOT_APPROVED', 'this approval was rejected; payment is not allowed');
  }

  const { data: existing } = await db.from('payments').select('*').eq('approval_id', approval.id).maybeSingle();
  if (existing?.status === 'paid') return json({ ok: true, already_paid: true, payment: existing });

  const { data: incident } = await db.from('incidents').select('*').eq('id', approval.incident_id).single();
  if (incident.status !== 'APPROVED') {
    return fail(409, 'INVALID_STATE', `incident is ${incident.status}, not APPROVED`);
  }

  const cents = approval.approved_amount_cents;
  const wholeDollars = cents % 100 === 0;
  const priceId = Deno.env.get(wholeDollars ? 'STRIPE_PRICE_PER_DOLLAR' : 'STRIPE_PRICE_PER_CENT');
  if (!priceId) {
    return fail(503, 'STRIPE_NOT_CONFIGURED', 'Stripe test mode is not configured for this project',
      'An admin must configure Stripe and set STRIPE_PRICE_PER_DOLLAR / STRIPE_PRICE_PER_CENT.');
  }

  let payment = existing;
  if (!payment) {
    const { data, error } = await db.from('payments').insert([{
      incident_id: incident.id,
      approval_id: approval.id,
      amount_cents: cents,
      idempotency_key: `approval:${approval.id}`,
    }]).select();
    if (error) return fail(422, 'PAYMENT_REJECTED_BY_DB', error.message);
    payment = data[0];
  }

  const base = Deno.env.get('APPROVAL_PAGE_URL') ?? 'https://example.com';
  if (agent) {
    return json({
      ok: true,
      incident: withNext(incident),
      payment: { id: payment.id, amount: dollars(cents), status: payment.status,
        pay_url: `${base}?incident=${incident.id}` },
      note: 'Payment is authorized and ready. The manager completes it on pay_url (Stripe test checkout). ' +
        'Status updates automatically; poll get_repair_status.',
    });
  }

  const { data: checkout, error } = await (manager!.userClient as any).payments.stripe.createCheckoutSession('test', {
    mode: 'payment',
    lineItems: [{ priceId, quantity: wholeDollars ? cents / 100 : cents }],
    successUrl: success_url ?? `${base}?incident=${incident.id}&paid=1`,
    cancelUrl: cancel_url ?? `${base}?incident=${incident.id}`,
    subject: { type: 'user', id: manager!.user.id },
    metadata: { payment_id: payment.id, incident_id: incident.id, approval_id: approval.id },
    idempotencyKey: payment.idempotency_key,
  });
  if (error) return fail(502, 'STRIPE_ERROR', error.message ?? String(error));

  const session = checkout.checkoutSession;
  await db.from('payments').update({ stripe_checkout_session_id: session.checkoutSessionId ?? session.id })
    .eq('id', payment.id);

  return json({
    ok: true,
    incident: withNext(incident),
    payment: { id: payment.id, amount: dollars(cents), status: 'pending', checkout_url: session.url },
    note: 'Open checkout_url to pay (Stripe test card 4242 4242 4242 4242). Status updates automatically.',
  });
});
