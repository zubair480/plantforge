// MCP tool: request_technician_quotes(incident_id, technician_ids?, max?)
// Emails approved contractors who match the recommended trade via Primitive.
// Replies arrive at email-inbound. Moves DIAGNOSED -> QUOTES_REQUESTED.

import { adminDb, checkToken, fail, handler, json, loadIncident, readJson, sendEmail, transition, withNext } from './_shared.ts';

export default handler(async (req) => {
  const denied = checkToken(req, 'x-agent-token', 'AGENT_API_TOKEN');
  if (denied) return denied;
  const { incident_id, technician_ids, max = 2 } = await readJson(req);
  if (!incident_id) return fail(400, 'MISSING_INCIDENT_ID', 'incident_id is required');

  const incident = await loadIncident(incident_id);
  if (!incident) return fail(404, 'NOT_FOUND', `incident ${incident_id} not found`);
  const allowed = ['DIAGNOSED', 'QUOTE_RECEIVED', 'ESCALATED'];
  if (!allowed.includes(incident.status)) {
    return fail(409, 'INVALID_STATE', `cannot request quotes while incident is ${incident.status}`,
      incident.status === 'DETECTED' ? 'Call investigate_incident first.' : 'Call get_repair_status.');
  }

  const db = adminDb();
  const { data: asset } = await db.from('assets').select('*').eq('id', incident.asset_id).single();
  let query = db.from('technicians').select('*').eq('active', true);
  if (Array.isArray(technician_ids) && technician_ids.length) query = query.in('id', technician_ids);
  const { data: all } = await query;
  const matching = (all ?? []).filter((t: any) => t.trades.includes(incident.recommended_trade));
  const chosen = (matching.length ? matching : all ?? []).slice(0, Number(max));
  if (!chosen.length) {
    return fail(404, 'NO_TECHNICIANS', 'no approved technicians available', 'Escalate to a human operator.');
  }

  const contacted = [];
  const failed = [];
  for (const tech of chosen) {
    const subject = `[${incident.id}] Repair quote request: ${asset.name}`;
    const text = `Hello ${tech.name},

We need a ${incident.recommended_trade} technician for an equipment fault.

Incident: ${incident.id}
Equipment: ${asset.name} (${asset.id})
Location: ${asset.location}
Alarm: ${incident.alarm_message ?? incident.alarm_id}
Readings at alarm: ${JSON.stringify(incident.tag_snapshot)}
Initial assessment: ${incident.diagnosis ?? 'pending'}

Please reply to this email with:
1. Your price (USD) for the call-out and repair
2. Your earliest arrival time
3. The scope of work you propose

Site access: report to the control room; PPE required.
Thank you,
Plant Maintenance Agent`;

    // One unreachable contractor must not block the others.
    try {
      const sent = await sendEmail({
        to: tech.email,
        subject,
        text,
        idempotencyKey: `quote-request:${incident.id}:${tech.id}`,
      });
      await db.from('outreach').insert([{
        incident_id: incident.id,
        technician_id: tech.id,
        primitive_email_id: sent?.id ?? null,
      }]);
      contacted.push({ technician_id: tech.id, name: tech.name, company: tech.company, email_id: sent?.id });
    } catch (e) {
      failed.push({ technician_id: tech.id, name: tech.name, error: e instanceof Error ? e.message : String(e) });
    }
  }

  if (!contacted.length) {
    return fail(502, 'EMAIL_FAILED', 'could not email any contractor', 'Escalate to a human operator.', { failed });
  }

  const updated = await transition(incident.id, incident.status, 'QUOTES_REQUESTED', 'agent',
    `Requested quotes from ${contacted.map((c) => c.name).join(', ')}`);

  return json({
    ok: true,
    incident: withNext(updated),
    contacted,
    failed,
    note: 'Contractors reply by email. Quotes appear automatically; poll get_repair_status.',
  });
});
