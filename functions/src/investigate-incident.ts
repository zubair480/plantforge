// MCP tool: investigate_incident(incident_id)
// Reads the alarm, tag snapshot, recent readings and asset context, asks the
// model for a diagnosis and the trade to dispatch, and moves DETECTED -> DIAGNOSED.

import { adminDb, checkToken, fail, handler, json, llmJson, loadIncident, readJson, transition, withNext } from './_shared.ts';
import { ruleBasedDiagnosis, TRADES } from './_logic.ts';

export default handler(async (req) => {
  const denied = checkToken(req, 'x-agent-token', 'AGENT_API_TOKEN');
  if (denied) return denied;
  const { incident_id } = await readJson(req);
  if (!incident_id) return fail(400, 'MISSING_INCIDENT_ID', 'incident_id is required');

  const incident = await loadIncident(incident_id);
  if (!incident) return fail(404, 'NOT_FOUND', `incident ${incident_id} not found`, 'Call get_active_incidents.');

  if (incident.status !== 'DETECTED') {
    // Idempotent: investigating twice returns the existing diagnosis.
    return json({ ok: true, already_investigated: true, incident: withNext(incident) });
  }

  const db = adminDb();
  const [{ data: asset }, { data: readings }] = await Promise.all([
    db.from('assets').select('*').eq('id', incident.asset_id).single(),
    db.from('readings').select('flow_lpm, run_cmd, fault, recorded_at')
      .eq('asset_id', incident.asset_id).order('recorded_at', { ascending: false }).limit(20),
  ]);

  const ai = await llmJson(
    'You are a maintenance engineer at a water-treatment plant. Diagnose SCADA alarms conservatively. ' +
      'You only read data; you never control equipment. Do not claim certainty about internal failures ' +
      `you cannot observe. recommended_trade must be one of: ${TRADES.join(', ')}.`,
    `Asset: ${JSON.stringify(asset)}
Alarm: ${incident.alarm_id} (${incident.severity}) - ${incident.alarm_message ?? ''}
Tag snapshot at alarm: ${JSON.stringify(incident.tag_snapshot)}
Recent readings (newest first): ${JSON.stringify(readings ?? [])}

Return JSON: {"diagnosis": string (2-3 sentences), "recommended_trade": string,
"confidence": number 0-1, "evidence": string[], "safety_notes": string}`,
  );

  const result = ai && TRADES.includes(ai.recommended_trade) ? ai : ruleBasedDiagnosis(incident, readings ?? []);
  const updated = await transition(incident.id, 'DETECTED', 'DIAGNOSED', 'agent',
    `Diagnosis (${ai ? 'model' : 'rules'}): ${result.diagnosis}`,
    { diagnosis: result.diagnosis, recommended_trade: result.recommended_trade });

  return json({
    ok: true,
    incident: withNext(updated),
    investigation: { ...result, source: ai ? 'model' : 'rules', asset, recent_readings: readings },
  });
});
