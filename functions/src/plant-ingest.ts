// Receives events pushed by Ignition (or scripts/simulate-alarm.mjs).
// Auth: x-plant-token header. The cloud never connects to the plant.
//
// Body:
// { "type": "alarm_active" | "alarm_cleared" | "reading",
//   "asset_id": "PUMP-101", "alarm_id": "PUMP101_LOW_FLOW",
//   "severity": "high", "message": "Flow low while pump commanded to run",
//   "tags": { "flow": 0, "run_cmd": true, "fault": true }, "ts": "2026-10-17T10:00:00Z" }

import { adminDb, checkToken, fail, handler, json, logEvent, NEXT_ACTIONS, pageManager, withNext } from './_shared.ts';

const OPEN_STATUSES = Object.keys(NEXT_ACTIONS).filter((s) => s !== 'VERIFIED' && s !== 'CANCELLED');

export default handler(async (req) => {
  const denied = checkToken(req, 'x-plant-token', 'PLANT_INGEST_TOKEN');
  if (denied) return denied;

  const body = await req.json().catch(() => null);
  if (!body?.type || !body?.asset_id) {
    return fail(400, 'BAD_EVENT', 'type and asset_id are required');
  }
  const db = adminDb();
  const tags = body.tags ?? {};
  const ts = body.ts ?? new Date().toISOString();

  const { data: asset } = await db.from('assets').select('id').eq('id', body.asset_id).maybeSingle();
  if (!asset) return fail(404, 'UNKNOWN_ASSET', `asset ${body.asset_id} is not registered`);

  // Every event carries a tag snapshot; keep it for verification.
  if (tags.flow !== undefined || tags.fault !== undefined || tags.run_cmd !== undefined) {
    await db.from('readings').insert([{
      asset_id: body.asset_id,
      flow_lpm: tags.flow ?? null,
      run_cmd: tags.run_cmd ?? null,
      fault: tags.fault ?? null,
      recorded_at: ts,
    }]);
  }

  if (body.type === 'reading') return json({ ok: true, stored: 'reading' });

  if (!body.alarm_id) return fail(400, 'BAD_EVENT', 'alarm_id is required for alarm events');

  const { data: open } = await db
    .from('incidents')
    .select('*')
    .eq('asset_id', body.asset_id)
    .eq('alarm_id', body.alarm_id)
    .in('status', OPEN_STATUSES)
    .maybeSingle();

  if (body.type === 'alarm_cleared') {
    if (!open) return json({ ok: true, note: 'no open incident for this alarm' });
    await logEvent(open.id, 'ignition', `Alarm ${body.alarm_id} cleared at ${ts}`);
    return json({ ok: true, incident_id: open.id, note: 'alarm cleared recorded; run verify_recovery' });
  }

  if (body.type !== 'alarm_active') return fail(400, 'BAD_EVENT', `unknown type ${body.type}`);

  // Ignition may resend the same alarm; never open a second incident for it.
  if (open) return json({ ok: true, duplicate: true, incident: withNext(open) });

  const { data, error } = await db
    .from('incidents')
    .insert([{
      asset_id: body.asset_id,
      alarm_id: body.alarm_id,
      severity: body.severity ?? 'high',
      alarm_message: body.message ?? null,
      tag_snapshot: tags,
      detected_at: ts,
      last_actor: 'ignition',
    }])
    .select();
  if (error) return fail(500, 'INSERT_FAILED', error.message);
  const page = await pageManager(data[0].id,
    `ALARM ${data[0].id}: ${body.message ?? body.alarm_id} (${body.asset_id}). The maintenance agent is investigating.`);
  return json({ ok: true, incident: withNext(data[0]), manager_paged: page.sent }, 201);
});
