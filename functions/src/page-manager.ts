// MCP tool: page_on_call_manager(incident_id, message, escalate?)
// Urgent iMessage to the on-call manager through Inkbox, for things email is
// too slow for (no contractor reply, safety concern). escalate=true also hands
// the incident to a human (status ESCALATED).

import { checkToken, fail, handler, json, loadIncident, pageManager, readJson, transition, withNext } from './_shared.ts';

export default handler(async (req) => {
  const denied = checkToken(req, 'x-agent-token', 'AGENT_API_TOKEN');
  if (denied) return denied;
  const { incident_id, message, escalate } = await readJson(req);
  if (!incident_id || !message) return fail(400, 'MISSING_FIELDS', 'incident_id and message are required');

  let incident = await loadIncident(incident_id);
  if (!incident) return fail(404, 'NOT_FOUND', `incident ${incident_id} not found`);

  const page = await pageManager(incident_id, `${incident_id}: ${String(message).slice(0, 500)}`);
  if (!page.sent) {
    return fail(503, 'PAGE_FAILED', 'could not reach the on-call manager by iMessage',
      'Fall back to email, or tell the user to contact the manager directly.', { page });
  }
  if (escalate && !['VERIFIED', 'CANCELLED', 'ESCALATED'].includes(incident.status)) {
    incident = await transition(incident_id, incident.status, 'ESCALATED', 'agent', `Escalated: ${message}`);
  }
  return json({ ok: true, paged: true, incident: withNext(incident) });
});
