// Read-only MCP tools in one function:
//   { "action": "list_active" }                      -> get_active_incidents()
//   { "action": "asset", "asset_id": "PUMP-101" }    -> get_asset_context(asset_id)
//   { "incident_id": "INC-101" }                     -> get_repair_status(incident_id)
//   { "action": "compare_quotes", "incident_id" }    -> compare_quotes(incident_id)

import { adminDb, checkToken, fail, handler, json, NEXT_ACTIONS, readJson, withNext } from './_shared.ts';
import { rankQuotes } from './_logic.ts';

const OPEN = Object.keys(NEXT_ACTIONS).filter((s) => s !== 'VERIFIED' && s !== 'CANCELLED');

export default handler(async (req) => {
  const denied = checkToken(req, 'x-agent-token', 'AGENT_API_TOKEN');
  if (denied) return denied;
  const { action, incident_id, asset_id } = await readJson(req);
  const db = adminDb();

  if (action === 'list_active') {
    const { data } = await db.from('incidents').select('*').in('status', OPEN).order('detected_at', { ascending: false });
    return json({ ok: true, incidents: (data ?? []).map(withNext) });
  }

  if (action === 'asset') {
    if (!asset_id) return fail(400, 'MISSING_ASSET_ID', 'asset_id is required');
    const [{ data: asset }, { data: readings }, { data: history }] = await Promise.all([
      db.from('assets').select('*').eq('id', asset_id).maybeSingle(),
      db.from('readings').select('flow_lpm, run_cmd, fault, recorded_at').eq('asset_id', asset_id)
        .order('recorded_at', { ascending: false }).limit(10),
      db.from('incidents').select('id, status, alarm_message, diagnosis, detected_at, verified_at')
        .eq('asset_id', asset_id).order('detected_at', { ascending: false }).limit(10),
    ]);
    if (!asset) return fail(404, 'UNKNOWN_ASSET', `asset ${asset_id} not found`);
    return json({ ok: true, asset, recent_readings: readings, incident_history: history });
  }

  if (!incident_id) {
    return fail(400, 'MISSING_INCIDENT_ID', 'incident_id is required (or action=list_active)');
  }
  const { data: incident } = await db.from('incidents').select('*').eq('id', incident_id).maybeSingle();
  if (!incident) return fail(404, 'NOT_FOUND', `incident ${incident_id} not found`, 'Call get_active_incidents.');

  const { data: quotes } = await db.from('quotes').select('*, technicians(name, company)').eq('incident_id', incident_id);
  const ranked = rankQuotes(quotes ?? []);

  if (action === 'compare_quotes') {
    const best = ranked.find((q) => q.is_complete);
    return json({
      ok: true,
      incident: withNext(incident),
      quotes: ranked,
      recommendation: best
        ? { quote_id: best.quote_id, reason: `Lowest complete quote (${best.amount}, arrival ${best.available_at}).` }
        : { quote_id: null, reason: 'No complete quote yet. Wait for replies or ask contractors for missing details.' },
    });
  }

  const [{ data: outreach }, { data: approvals }, { data: payments }, { data: evidence }, { data: timeline }] =
    await Promise.all([
      db.from('outreach').select('sent_at, replied_at, technicians(name, company)').eq('incident_id', incident_id),
      db.from('approvals').select('id, quote_id, decision, approved_amount_cents, created_at').eq('incident_id', incident_id),
      db.from('payments').select('id, approval_id, amount_cents, status, paid_at').eq('incident_id', incident_id),
      db.from('evidence').select('kind, notes, storage_url, submitted_by, created_at').eq('incident_id', incident_id),
      db.from('incident_events').select('from_status, to_status, actor, detail, created_at')
        .eq('incident_id', incident_id).order('created_at', { ascending: true }),
    ]);

  return json({
    ok: true,
    incident: withNext(incident),
    outreach,
    quotes: ranked,
    approvals,
    payments,
    evidence,
    timeline,
  });
});
