// Stand-in for Ignition: posts the same events Ignition's gateway script will send.
// Reads INSFORGE_FUNCTIONS_URL and PLANT_INGEST_TOKEN from .env.local.
//
//   node scripts/simulate-plant.mjs alarm            # pump fails: flow 0, fault on
//   node scripts/simulate-plant.mjs healthy [secs]   # operator cleared fault: healthy readings every 5s
//   node scripts/simulate-plant.mjs faulty [secs]    # still broken: faulty readings every 5s

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const envFile = readFileSync(join(import.meta.dirname, '..', '.env.local'), 'utf8');
const env = Object.fromEntries(
  envFile.split(/\r?\n/).filter((l) => /^\w+=/.test(l)).map((l) => [l.split('=')[0], l.slice(l.indexOf('=') + 1)]),
);
const url = `${env.INSFORGE_FUNCTIONS_URL}/plant-ingest`;

const ASSET = 'PUMP-101';
const ALARM = 'PUMP101_LOW_FLOW';

async function post(event) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-plant-token': env.PLANT_INGEST_TOKEN },
    body: JSON.stringify({ asset_id: ASSET, ts: new Date().toISOString(), ...event }),
  });
  const body = await res.json();
  console.log(res.status, JSON.stringify(body));
  return body;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const [cmd = 'alarm', secs = '40'] = process.argv.slice(2);

if (cmd === 'alarm') {
  await post({
    type: 'alarm_active',
    alarm_id: ALARM,
    severity: 'high',
    message: 'Pump 101 low flow: commanded to run, flow 0 L/min, drive fault active',
    tags: { flow: 0, run_cmd: true, fault: true },
  });
} else if (cmd === 'healthy' || cmd === 'faulty') {
  const healthy = cmd === 'healthy';
  if (healthy) await post({ type: 'alarm_cleared', alarm_id: ALARM, tags: { flow: 120, run_cmd: true, fault: false } });
  for (let t = 0; t <= Number(secs); t += 5) {
    await post({
      type: 'reading',
      tags: healthy
        ? { flow: 118 + Math.round(Math.random() * 6), run_cmd: true, fault: false }
        : { flow: 0, run_cmd: true, fault: true },
    });
    if (t + 5 <= Number(secs)) await sleep(5000);
  }
} else {
  console.error('usage: node scripts/simulate-plant.mjs alarm | healthy [secs] | faulty [secs]');
  process.exit(1);
}
