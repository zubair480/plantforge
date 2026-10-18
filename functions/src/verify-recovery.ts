// MCP tool: verify_recovery(incident_id, window_seconds?)
// Independent check using plant readings pushed by Ignition after the repair report:
// flow must stay at or above the asset's threshold with no fault for the whole window.
// REPAIR_REPORTED -> VERIFYING -> VERIFIED | VERIFICATION_FAILED.

import { adminDb, checkToken, fail, handler, json, loadIncident, pageManager, readJson, transition, withNext } from './_shared.ts';
import { recoveryVerdict } from './_logic.ts';

export default handler(async (req) => {
  const denied = checkToken(req, 'x-agent-token', 'AGENT_API_TOKEN');
  if (denied) return denied;
  const { incident_id, window_seconds = 30 } = await readJson(req);
  if (!incident_id) return fail(400, 'MISSING_INCIDENT_ID', 'incident_id is required');
  const seconds = Number(window_seconds);
  const windowMs = Math.min(3600, Math.max(10, Number.isFinite(seconds) ? seconds : 30)) * 1000;

  let incident = await loadIncident(incident_id);
  if (!incident) return fail(404, 'NOT_FOUND', `incident ${incident_id} not found`);
  if (incident.status === 'VERIFIED') return json({ ok: true, verified: true, incident: withNext(incident) });
  if (incident.status === 'REPAIR_REPORTED') {
    incident = await transition(incident_id, 'REPAIR_REPORTED', 'VERIFYING', 'agent', 'Verification started');
  } else if (incident.status !== 'VERIFYING') {
    return fail(409, 'INVALID_STATE', `cannot verify while incident is ${incident.status}`,
      'A repair must be reported first (report_repair).');
  }

  const db = adminDb();
  const [{ data: asset }, { data: reportEvt }] = await Promise.all([
    db.from('assets').select('*').eq('id', incident.asset_id).single(),
    db.from('incident_events').select('created_at').eq('incident_id', incident_id)
      .eq('to_status', 'REPAIR_REPORTED').order('created_at', { ascending: false }).limit(1).maybeSingle(),
  ]);
  // Only readings after the repair report and inside the window count.
  // Compare as instants: the database and JS format timestamps differently.
  const now = Date.now();
  const sinceMs = Date.parse(reportEvt?.created_at ?? incident.updated_at);
  const fromMs = Math.max(Number.isFinite(sinceMs) ? sinceMs : 0, now - windowMs);

  const { data: readings } = await db.from('readings').select('flow_lpm, fault, run_cmd, recorded_at')
    .eq('asset_id', incident.asset_id)
    .gte('recorded_at', new Date(fromMs).toISOString())
    .order('recorded_at', { ascending: true });

  const threshold = Number(asset.flow_min_lpm);
  const { result, summary } = recoveryVerdict(readings ?? [], { windowMs, thresholdLpm: threshold, now });

  if (result === 'failed') {
    // The most recent plant data still shows the problem after the repair.
    const failed = await transition(incident_id, 'VERIFYING', 'VERIFICATION_FAILED', 'agent',
      `Recovery not confirmed: ${JSON.stringify(summary)}`);
    await pageManager(incident_id, `RECOVERY FAILED ${incident_id}: plant data still shows the fault after the repair. Technician needs to return.`);
    return json({ ok: true, verified: false, result: 'failed', summary, incident: withNext(failed) });
  }

  // Readings from before the operator cleared the fault may still be in the
  // window; wait until the whole window is healthy.
  if (result === 'waiting_for_data') {
    return json({
      ok: true,
      verified: false,
      result: 'waiting_for_data',
      summary,
      incident: withNext(incident),
      hint: `Need ${windowMs / 1000}s of healthy readings (flow >= ${threshold} L/min, no fault). Call again shortly.`,
    });
  }

  await db.from('evidence').insert([{
    incident_id, kind: 'reading', notes: `Verified recovery: ${JSON.stringify(summary)}`, submitted_by: 'ignition',
  }]);
  const verified = await transition(incident_id, 'VERIFYING', 'VERIFIED', 'agent',
    `Recovery verified: flow >= ${threshold} L/min with no fault for ${summary.observed_seconds}s`);
  await pageManager(incident_id, `RESOLVED ${incident_id}: recovery verified from plant data (flow >= ${threshold} L/min, no fault, ${summary.observed_seconds}s). Incident closed.`);
  return json({ ok: true, verified: true, result: 'verified', summary, incident: withNext(verified) });
});
