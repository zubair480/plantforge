// Autopilot maintenance agent. Runs 24/7 in a Blaxel sandbox.
// It is an ordinary MCP client of our Manufact server: every 15 seconds it lists
// open incidents and moves each one forward with the same tools any agent uses.
// It cannot approve or pay: the backend refuses, and humans do that on the
// approval page. Plain Node 18+, no dependencies.
//
//   MCP_URL=https://dark-forge-tma6f.run.mcp-use.com/mcp node autopilot.mjs
//   GET http://<host>:8080/ -> recent actions as JSON

import { createServer } from 'node:http';

const MCP_URL = process.env.MCP_URL ?? 'https://dark-forge-tma6f.run.mcp-use.com/mcp';
const INTERVAL_MS = Number(process.env.INTERVAL_MS ?? 15000);
const NO_REPLY_PAGE_MS = Number(process.env.NO_REPLY_PAGE_MS ?? 10 * 60 * 1000);

let session;
let rpcId = 0;
const done = new Set(); // "INC-101:DETECTED" -> already acted on this status
const log = [];

function record(incident, action, detail) {
  const entry = { at: new Date().toISOString(), incident, action, detail };
  log.unshift(entry);
  log.length = Math.min(log.length, 200);
  console.log(`[${entry.at}] ${incident} ${action}: ${detail}`);
}

async function rpc(method, params, notify = false) {
  const res = await fetch(MCP_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(session ? { 'mcp-session-id': session } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', method, params, ...(notify ? {} : { id: ++rpcId }) }),
  });
  session = res.headers.get('mcp-session-id') ?? session;
  if (notify) return null;
  const text = await res.text();
  const payload = text.trim().startsWith('{')
    ? text
    : text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5)).pop();
  const msg = JSON.parse(payload);
  if (msg.error) throw new Error(`${method}: ${JSON.stringify(msg.error)}`);
  return msg.result;
}

async function connect() {
  session = undefined;
  await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'blaxel-autopilot', version: '1.0.0' },
  });
  await rpc('notifications/initialized', {}, true);
}

async function tool(name, args = {}) {
  let result;
  try {
    result = await rpc('tools/call', { name, arguments: args });
  } catch (e) {
    // Session expired or server redeployed: reconnect once and retry.
    await connect();
    result = await rpc('tools/call', { name, arguments: args });
  }
  const data = result.structuredContent ?? JSON.parse(result.content?.[0]?.text ?? '{}');
  return { ok: !result.isError, data };
}

const once = (key) => (done.has(key) ? false : (done.add(key), true));
const err = (r) => r.data?.error?.message ?? 'ok';

async function work(incident) {
  const { id, status } = incident;
  const key = `${id}:${status}`;

  switch (status) {
    case 'DETECTED': {
      if (!once(key)) return;
      const r = await tool('investigate_incident', { incident_id: id });
      record(id, 'investigate_incident', r.ok ? r.data.incident?.diagnosis?.slice(0, 120) : err(r));
      break;
    }
    case 'DIAGNOSED': {
      if (!once(key)) return;
      const r = await tool('request_technician_quotes', { incident_id: id });
      record(id, 'request_technician_quotes',
        r.ok ? `emailed ${r.data.contacted?.map((c) => c.name).join(', ')}` : err(r));
      break;
    }
    case 'QUOTES_REQUESTED': {
      const waited = Date.now() - Date.parse(incident.updated_at);
      if (waited > NO_REPLY_PAGE_MS && once(`${key}:page`)) {
        const r = await tool('page_on_call_manager', {
          incident_id: id,
          message: `No contractor has replied to the quote request after ${Math.round(waited / 60000)} min. Please call one.`,
        });
        record(id, 'page_on_call_manager', r.ok ? 'no-reply alert sent' : err(r));
      }
      break;
    }
    case 'QUOTE_RECEIVED': {
      const cmp = await tool('compare_quotes', { incident_id: id });
      const quoteId = cmp.data?.recommendation?.quote_id;
      if (!quoteId) return; // incomplete quotes only: keep waiting for a complete one
      if (!once(`${key}:${quoteId}`)) return;
      const r = await tool('request_manager_approval', { incident_id: id, quote_id: quoteId });
      record(id, 'request_manager_approval',
        r.ok ? `${r.data.approval_request?.amount} sent for human approval` : err(r));
      break;
    }
    case 'APPROVED': {
      if (!once(key)) return;
      const status = await tool('get_repair_status', { incident_id: id });
      const approval = status.data?.approvals?.findLast?.((a) => a.decision === 'approved');
      if (!approval) return;
      const r = await tool('create_authorized_payment', { approval_id: approval.id });
      record(id, 'create_authorized_payment', r.ok ? `ready to pay at ${r.data.payment?.pay_url}` : err(r));
      break;
    }
    case 'REPAIR_REPORTED':
    case 'VERIFYING': {
      // Re-check every cycle until plant data gives a verdict.
      const r = await tool('verify_recovery', { incident_id: id });
      if (r.data?.result !== 'waiting_for_data' || once(`${key}:waiting`)) {
        record(id, 'verify_recovery', r.ok ? r.data.result : err(r));
      }
      break;
    }
    default:
      // APPROVAL_PENDING, PAID, SCHEDULED, ESCALATED: waiting on humans or Stripe.
      break;
  }
}

async function tick() {
  try {
    const r = await tool('get_active_incidents');
    for (const incident of r.data?.incidents ?? []) {
      await work(incident).catch((e) => record(incident.id, 'error', e.message));
    }
  } catch (e) {
    record('-', 'error', e.message);
  }
}

// Cloud stand-in for Ignition, so a demo needs no laptop: the same events
// scripts/simulate-plant.mjs sends. Needs PLANT_INGEST_TOKEN.
const INGEST_URL = `${process.env.INSFORGE_FUNCTIONS_URL ?? 'https://nden3esm.us-west.insforge.app/functions'}/plant-ingest`;
const PLANT = { asset_id: 'PUMP-101', alarm_id: 'PUMP101_LOW_FLOW' };

async function plantEvent(event) {
  const res = await fetch(INGEST_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-plant-token': process.env.PLANT_INGEST_TOKEN ?? '' },
    body: JSON.stringify({ asset_id: PLANT.asset_id, ts: new Date().toISOString(), ...event }),
  });
  return res.json().catch(() => ({ status: res.status }));
}

async function simulate(kind, secs) {
  if (kind === 'alarm') {
    return plantEvent({
      type: 'alarm_active', alarm_id: PLANT.alarm_id, severity: 'high',
      message: 'Pump 101 low flow: commanded to run, flow 0 L/min, drive fault active',
      tags: { flow: 0, run_cmd: true, fault: true },
    });
  }
  const healthy = kind === 'healthy';
  if (healthy) await plantEvent({ type: 'alarm_cleared', alarm_id: PLANT.alarm_id, tags: { flow: 120, run_cmd: true, fault: false } });
  // Stream readings in the background so the HTTP call returns immediately.
  (async () => {
    for (let t = 0; t <= secs; t += 5) {
      await plantEvent({
        type: 'reading',
        tags: healthy ? { flow: 118 + Math.round(Math.random() * 6), run_cmd: true, fault: false }
          : { flow: 0, run_cmd: true, fault: true },
      });
      await new Promise((r) => setTimeout(r, 5000));
    }
  })().catch((e) => record('-', 'error', `simulator: ${e.message}`));
  return { ok: true, streaming: `${kind} readings for ${secs}s` };
}

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const send = (code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body, null, 2));
  };
  const sim = url.pathname.match(/^\/simulate\/(alarm|healthy|faulty)$/);
  if (sim) {
    if (!process.env.PLANT_INGEST_TOKEN) return send(503, { error: 'PLANT_INGEST_TOKEN not set' });
    const result = await simulate(sim[1], Number(url.searchParams.get('secs') ?? 35));
    record('-', `simulate_${sim[1]}`, JSON.stringify(result).slice(0, 120));
    return send(200, result);
  }
  send(200, {
    agent: 'plant-autopilot',
    mcp: MCP_URL,
    simulate: ['/simulate/alarm', '/simulate/healthy?secs=35', '/simulate/faulty?secs=10'],
    recent_actions: log,
  });
}).listen(Number(process.env.PORT ?? 8080));

await connect();
record('-', 'started', `watching ${MCP_URL} every ${INTERVAL_MS / 1000}s`);
await tick();
setInterval(tick, INTERVAL_MS);
