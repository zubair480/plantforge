// MCP tool: report_repair(incident_id, report, photo_url?, storage_key?, submitted_by?)
// Records the technician's repair report as evidence. SCHEDULED -> REPAIR_REPORTED.
// This is the technician's claim only; verify_recovery checks the plant data.

import { adminDb, checkToken, fail, handler, json, loadIncident, readJson, transition, withNext } from './_shared.ts';

export default handler(async (req) => {
  const denied = checkToken(req, 'x-agent-token', 'AGENT_API_TOKEN');
  if (denied) return denied;
  const { incident_id, report, photo_url, storage_key, submitted_by } = await readJson(req);
  if (!incident_id || !report) return fail(400, 'MISSING_FIELDS', 'incident_id and report are required');

  const incident = await loadIncident(incident_id);
  if (!incident) return fail(404, 'NOT_FOUND', `incident ${incident_id} not found`);
  if (incident.status !== 'SCHEDULED') {
    return fail(409, 'INVALID_STATE', `cannot report a repair while incident is ${incident.status}`,
      incident.status === 'APPROVED' ? 'The approved payment must complete first.' : 'Call get_repair_status.');
  }

  const db = adminDb();
  await db.from('evidence').insert([
    { incident_id, kind: 'repair_report', notes: report, submitted_by: submitted_by ?? 'technician' },
    ...(photo_url ? [{ incident_id, kind: 'photo', storage_url: photo_url, storage_key, submitted_by }] : []),
  ]);

  const updated = await transition(incident_id, 'SCHEDULED', 'REPAIR_REPORTED', 'technician',
    `Repair reported: ${String(report).slice(0, 200)}`);
  return json({
    ok: true,
    incident: withNext(updated),
    note: 'An authorized operator must clear the fault on site; then call verify_recovery.',
  });
});
