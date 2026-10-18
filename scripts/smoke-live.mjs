// Post-deploy smoke test against the live edge functions. It changes no data:
// every write call is aimed at a state or input the backend must refuse.
//   AGENT_API_TOKEN=... PLANT_INGEST_TOKEN=... node scripts/smoke-live.mjs
// Reads .env.local when the variables are not set.

import { existsSync, readFileSync } from 'node:fs';

if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

const F = process.env.INSFORGE_FUNCTIONS_URL ?? 'https://nden3esm.us-west.insforge.app/functions';
const AGENT = process.env.AGENT_API_TOKEN;
const PLANT = process.env.PLANT_INGEST_TOKEN;
if (!AGENT || !PLANT) {
  console.error('set AGENT_API_TOKEN and PLANT_INGEST_TOKEN');
  process.exit(2);
}

async function call(slug, body, headers = {}) {
  const res = await fetch(`${F}/${slug}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, code: data?.error?.code ?? (data.ok ? 'ok' : 'unknown'), data };
}

const agent = { 'x-agent-token': AGENT };
const list = await call('incident-status', { action: 'list_active' }, agent);
// Pick an incident whose status makes report/verify illegal, so those calls are refused.
const idle = (list.data.incidents ?? []).find((i) => !['SCHEDULED', 'REPAIR_REPORTED', 'VERIFYING', 'VERIFICATION_FAILED'].includes(i.status));

const checks = [
  ['list incidents with agent token', list, 200, 'ok'],
  ['list incidents without token', await call('incident-status', { action: 'list_active' }), 401, 'UNAUTHORIZED'],
  ['agent cannot approve spend', await call('approve-quote', {}, agent), 403, 'HUMAN_APPROVAL_REQUIRED'],
  ['payment needs an approval', await call('create-payment', { approval_id: '00000000-0000-0000-0000-000000000000' }, agent), 404, 'APPROVAL_NOT_FOUND'],
  ['webhook needs a valid signature', await call('email-inbound', { event: 'email.received' }, { 'Primitive-Signature': 't=1,v1=00' }), 401, 'BAD_SIGNATURE'],
  ['plant ingest rejects unknown asset', await call('plant-ingest', { type: 'reading', asset_id: 'NO-SUCH-ASSET' }, { 'x-plant-token': PLANT }), 404, 'UNKNOWN_ASSET'],
  ['plant ingest needs plant token', await call('plant-ingest', { type: 'reading', asset_id: 'PUMP-101' }, agent), 401, 'UNAUTHORIZED'],
];
if (idle) {
  checks.push(
    [`verify refused while ${idle.id} is ${idle.status}`, await call('verify-recovery', { incident_id: idle.id }, agent), 409, 'INVALID_STATE'],
    [`report refused while ${idle.id} is ${idle.status}`, await call('report-repair', { incident_id: idle.id, report: 'smoke' }, agent), 409, 'INVALID_STATE'],
  );
}

let failed = 0;
for (const [name, r, status, code] of checks) {
  const ok = r.status === status && r.code === code;
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} (${r.status} ${r.code})`);
}
console.log(failed ? `\n${failed} live check(s) failed` : `\nall ${checks.length} live checks passed`);
process.exit(failed ? 1 : 0);
