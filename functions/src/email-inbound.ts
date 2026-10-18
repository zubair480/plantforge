// Primitive webhook for contractor replies (event "email.received").
// Verifies the Primitive-Signature HMAC, matches the reply to an incident and
// technician, extracts price / arrival / scope, and stores a quote.
// QUOTES_REQUESTED -> QUOTE_RECEIVED on the first quote.
//
// Testing fallback, only when the secret ALLOW_MANUAL_INBOUND=true: callers with
// x-agent-token may post { "from": "...", "subject": "[INC-101] ...", "text": "...", "email_id": "test-1" }.
// Keep it off in production, otherwise an agent could inject a contractor quote.

import { adminDb, env, fail, handler, isAgent, json, llmJson, transition } from './_shared.ts';

async function verifySignature(raw: string, header: string | null): Promise<boolean> {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(',').map((p) => p.trim().split('=') as [string, string]));
  const t = Number(parts.t);
  if (!t || !parts.v1 || Math.abs(Date.now() / 1000 - t) > 300) return false;
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(env('PRIMITIVE_WEBHOOK_SECRET')),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${raw}`));
  const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
  if (hex.length !== parts.v1.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ parts.v1.charCodeAt(i);
  return diff === 0;
}

const addressOf = (from: string) => (from.match(/<([^>]+)>/)?.[1] ?? from).trim().toLowerCase();

// Strip quoted history so we only parse what the contractor wrote.
const stripQuoted = (text: string) =>
  text.split(/\n\s*On .+wrote:|\n-{2,}\s*Original Message|\n>/)[0].trim();

function regexQuote(text: string) {
  const amount = text.match(/\$\s?([\d,]+(?:\.\d{1,2})?)/);
  return {
    amount_usd: amount ? Number(amount[1].replace(/,/g, '')) : null,
    available_at: null,
    scope: text.slice(0, 300),
    missing: amount ? ['available_at'] : ['amount_usd', 'available_at'],
  };
}

export default handler(async (req) => {
  const raw = await req.text();
  let email: { id: string; from: string; subject: string; text: string };

  const manualAllowed = Deno.env.get('ALLOW_MANUAL_INBOUND') === 'true';
  if (isAgent(req)) {
    if (!manualAllowed) {
      return fail(403, 'MANUAL_INBOUND_DISABLED', 'contractor replies must arrive as signed Primitive webhooks',
        'Set the secret ALLOW_MANUAL_INBOUND=true only for testing.');
    }
    let b: Record<string, any>;
    try {
      b = JSON.parse(raw || '{}');
    } catch {
      return fail(400, 'BAD_JSON', 'body must be JSON');
    }
    if (!b.from) return fail(400, 'MISSING_FIELDS', 'from is required');
    email = { id: b.email_id ?? `manual-${crypto.randomUUID()}`, from: b.from, subject: b.subject ?? '', text: b.text ?? '' };
  } else {
    if (!(await verifySignature(raw, req.headers.get('Primitive-Signature')))) {
      return fail(401, 'BAD_SIGNATURE', 'invalid Primitive-Signature');
    }
    const evt = JSON.parse(raw);
    if (evt.event !== 'email.received' || !evt.email) return json({ ok: true, ignored: evt.event });
    const e = evt.email;
    email = {
      id: e.id,
      from: e.headers?.from ?? e.smtp?.mail_from ?? '',
      subject: e.headers?.subject ?? '',
      text: e.parsed?.body_text ?? '',
    };
  }

  const db = adminDb();
  const sender = addressOf(email.from ?? '');
  const incidentId = (email.subject + ' ' + email.text).match(/INC-\d+/)?.[0];
  const { data: tech } = await db.from('technicians').select('*').eq('email', sender).maybeSingle();
  if (!incidentId || !tech) {
    // 2xx so Primitive does not retry mail we will never be able to match.
    return json({ ok: true, ignored: 'not a reply from a known technician about an incident', sender, incidentId });
  }

  const { data: outreach } = await db.from('outreach').select('*')
    .eq('incident_id', incidentId).eq('technician_id', tech.id).maybeSingle();
  if (!outreach) return json({ ok: true, ignored: 'technician was not contacted for this incident' });
  await db.from('outreach').update({ replied_at: new Date().toISOString() }).eq('id', outreach.id);

  const body = stripQuoted(email.text);
  const tz = Deno.env.get('PLANT_TIMEZONE') ?? 'America/Los_Angeles';
  const plantNow = new Date().toLocaleString('en-US', { timeZone: tz, dateStyle: 'full', timeStyle: 'long' });
  const ai = await llmJson(
    'Extract a contractor quote from an email reply. Never invent values; use null when not stated. ' +
      `The plant is in time zone ${tz}; it is now ${plantNow} there. Times without a zone are plant-local. ` +
      'Return available_at as ISO-8601 with the correct UTC offset for that zone (e.g. 2026-10-17T14:00:00-07:00).',
    `Email from ${tech.name} (${tech.company}):\n"""${body}"""\n
Return JSON: {"amount_usd": number|null, "available_at": ISO-8601 string|null,
"scope": string|null, "missing": string[] (which of amount_usd, available_at, scope are absent)}`,
  );
  const q = ai ?? regexQuote(body);
  const parsedCents = Math.round(Number(q.amount_usd) * 100);
  const amountCents = Number.isFinite(parsedCents) && parsedCents > 0 ? parsedCents : null;
  const availableAt = q.available_at && !isNaN(Date.parse(q.available_at)) ? q.available_at : null;
  const isComplete = !!(amountCents && availableAt && q.scope);

  const { data: inserted, error } = await db.from('quotes').insert([{
    incident_id: incidentId,
    technician_id: tech.id,
    amount_cents: amountCents,
    available_at: availableAt,
    scope: q.scope ?? null,
    is_complete: isComplete,
    source_email_id: email.id,
  }]).select();
  if (error) {
    if (/duplicate/i.test(error.message)) return json({ ok: true, duplicate: true });
    return fail(500, 'INSERT_FAILED', error.message);
  }

  const { data: incident } = await db.from('incidents').select('status').eq('id', incidentId).single();
  if (incident?.status === 'QUOTES_REQUESTED') {
    await transition(incidentId, 'QUOTES_REQUESTED', 'QUOTE_RECEIVED', 'technician',
      `Quote from ${tech.name}: ${amountCents ? `$${(amountCents / 100).toFixed(2)}` : 'no price'}` +
        `${availableAt ? `, arrival ${availableAt}` : ''}${isComplete ? '' : ' (incomplete)'}`);
  }

  return json({ ok: true, incident_id: incidentId, quote: inserted[0], missing: q.missing ?? [] });
});
