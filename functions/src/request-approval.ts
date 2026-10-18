// MCP tool: request_manager_approval(incident_id, quote_id)
// The agent picks a quote and asks a human. Agents can never approve spend
// themselves; approval happens in approve-quote with a manager login.
// QUOTE_RECEIVED -> APPROVAL_PENDING.

import { adminDb, checkToken, fail, handler, json, loadIncident, pageManager, readJson, transition, withNext } from './_shared.ts';
import { dollars } from './_logic.ts';

export default handler(async (req) => {
  const denied = checkToken(req, 'x-agent-token', 'AGENT_API_TOKEN');
  if (denied) return denied;
  const { incident_id, quote_id } = await readJson(req);
  if (!incident_id || !quote_id) return fail(400, 'MISSING_FIELDS', 'incident_id and quote_id are required');

  const incident = await loadIncident(incident_id);
  if (!incident) return fail(404, 'NOT_FOUND', `incident ${incident_id} not found`);

  const db = adminDb();
  const { data: quote } = await db.from('quotes').select('*, technicians(name, company)')
    .eq('id', quote_id).eq('incident_id', incident_id).maybeSingle();
  if (!quote) return fail(404, 'QUOTE_NOT_FOUND', 'quote does not exist for this incident', 'Call compare_quotes.');

  if (incident.status === 'APPROVAL_PENDING') {
    return json({ ok: true, already_pending: true, incident: withNext(incident) });
  }
  if (incident.status !== 'QUOTE_RECEIVED') {
    return fail(409, 'INVALID_STATE', `cannot request approval while incident is ${incident.status}`);
  }
  if (!quote.is_complete) {
    return fail(422, 'QUOTE_INCOMPLETE', 'quote is missing price, arrival time or scope',
      'Ask the contractor for the missing details (reply to their email) or choose another quote.',
      { quote });
  }

  await db.from('quotes').update({ status: 'selected' }).eq('id', quote.id);
  const updated = await transition(incident.id, 'QUOTE_RECEIVED', 'APPROVAL_PENDING', 'agent',
    `Requested manager approval for ${dollars(quote.amount_cents)} from ${quote.technicians?.name}`);

  const page = Deno.env.get('APPROVAL_PAGE_URL');
  const approvalUrl = page ? `${page}?incident=${incident.id}&quote=${quote.id}` : null;
  const paged = await pageManager(incident.id,
    `APPROVAL NEEDED ${incident.id}: ${quote.technicians?.name} quoted ${dollars(quote.amount_cents)} ` +
      `(${quote.scope ?? 'repair'}). Approve or reject: ${approvalUrl ?? 'approval page'}`);
  return json({
    ok: true,
    incident: withNext(updated),
    manager_paged: paged.sent,
    approval_request: {
      quote_id: quote.id,
      amount: dollars(quote.amount_cents),
      amount_cents: quote.amount_cents,
      technician: quote.technicians,
      scope: quote.scope,
      available_at: quote.available_at,
      approval_url: approvalUrl,
    },
    note: 'A signed-in human manager must approve this exact amount. Agents cannot approve.',
  });
});
