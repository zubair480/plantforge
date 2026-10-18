// Pure decision logic shared by the edge functions. No Deno, network or
// database access, so functions/test/*.test.ts can run it under plain Node.
// scripts/build-functions.mjs inlines this file into each function.

// ---------------------------------------------------------------------------
// Primitive webhook signature: header "t=<unix seconds>,v1=<hex hmac-sha256 of `${t}.${raw}`>"

export async function verifyPrimitiveSignature(
  raw: string,
  header: string | null,
  secret: string,
  nowSec = Date.now() / 1000,
  toleranceSec = 300,
): Promise<boolean> {
  if (!header || !secret) return false;
  const parts: Record<string, string> = {};
  for (const p of header.split(',')) {
    const i = p.indexOf('=');
    if (i > 0) parts[p.slice(0, i).trim()] = p.slice(i + 1).trim();
  }
  const t = Number(parts.t);
  if (!t || !parts.v1 || Math.abs(nowSec - t) > toleranceSec) return false;
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${raw}`));
  const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const got = parts.v1.toLowerCase();
  if (hex.length !== got.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0;
}

// ---------------------------------------------------------------------------
// Contractor replies

export const addressOf = (from: string) => (from.match(/<([^>]+)>/)?.[1] ?? from).trim().toLowerCase();

/** Keep only what the contractor wrote, dropping quoted history. */
export const stripQuoted = (text: string) =>
  text.split(/\n\s*On .+wrote:|\n-{2,}\s*Original Message|\n>/)[0].trim();

/** First incident id mentioned in the subject or body, e.g. "INC-104". */
export const incidentIdIn = (...texts: string[]) => texts.join(' ').match(/INC-\d+/)?.[0];

/** Fallback when the model is unavailable: price only, never a guessed arrival time. */
export function regexQuote(text: string) {
  const amount = text.match(/\$\s?([\d,]+(?:\.\d{1,2})?)/);
  return {
    amount_usd: amount ? Number(amount[1].replace(/,/g, '')) : null,
    available_at: null as string | null,
    scope: text.slice(0, 300),
    missing: amount ? ['available_at'] : ['amount_usd', 'available_at'],
  };
}

/** Dollars from any source (model or regex) to positive integer cents, or null. */
export function toCents(amountUsd: unknown): number | null {
  const cents = Math.round(Number(amountUsd) * 100);
  return Number.isFinite(cents) && cents > 0 ? cents : null;
}

export const dollars = (cents: number | null | undefined) =>
  cents == null ? null : `$${(cents / 100).toFixed(2)}`;

// ---------------------------------------------------------------------------
// Quotes: complete first, then cheapest, then earliest arrival.

export function rankQuotes(quotes: any[]) {
  return quotes
    .filter((q) => q.status !== 'rejected')
    .map((q) => ({
      quote_id: q.id,
      technician: q.technicians?.name,
      company: q.technicians?.company,
      amount: dollars(q.amount_cents),
      amount_cents: q.amount_cents,
      available_at: q.available_at,
      scope: q.scope,
      is_complete: q.is_complete,
      status: q.status,
    }))
    .sort((a, b) =>
      Number(b.is_complete) - Number(a.is_complete) ||
      (a.amount_cents ?? Infinity) - (b.amount_cents ?? Infinity) ||
      Date.parse(a.available_at ?? '9999') - Date.parse(b.available_at ?? '9999'));
}

// ---------------------------------------------------------------------------
// Diagnosis fallback when the model is unavailable.

export const TRADES = ['mechanical', 'electrical', 'pump', 'motor', 'instrumentation'];

export function ruleBasedDiagnosis(incident: any, readings: any[]) {
  const t = incident.tag_snapshot ?? {};
  const noFlow = Number(t.flow ?? readings[0]?.flow_lpm ?? 0) <= 0;
  if (t.run_cmd && noFlow && t.fault) {
    return {
      diagnosis: 'Pump is commanded to run but delivers no flow and the drive reports a fault. ' +
        'Likely causes: tripped motor/drive, seized pump, or blocked suction. Needs on-site inspection.',
      recommended_trade: 'pump',
      confidence: 0.6,
      evidence: ['run command ON', 'flow 0 L/min', 'fault bit active'],
    };
  }
  return {
    diagnosis: 'Abnormal operating condition reported by SCADA. On-site inspection required.',
    recommended_trade: 'mechanical',
    confidence: 0.4,
    evidence: [`tag snapshot ${JSON.stringify(t)}`],
  };
}

// ---------------------------------------------------------------------------
// Recovery verdict from plant readings (oldest first) after the repair report.

export type Reading = { flow_lpm: number | string | null; fault: boolean | null; recorded_at: string };

export function recoveryVerdict(rows: Reading[], opts: { windowMs: number; thresholdLpm: number; now: number }) {
  const { windowMs, thresholdLpm, now } = opts;
  const isBad = (r: Reading) => r.fault === true || Number(r.flow_lpm ?? 0) < thresholdLpm;
  const bad = rows.filter(isBad);
  const spanMs = rows.length > 1
    ? Date.parse(rows[rows.length - 1].recorded_at) - Date.parse(rows[0].recorded_at) : 0;
  const latest = rows[rows.length - 1];
  const lastAge = latest ? now - Date.parse(latest.recorded_at) : Infinity;
  const summary = {
    window_seconds: windowMs / 1000,
    readings_in_window: rows.length,
    observed_seconds: Math.round(spanMs / 1000),
    flow_threshold_lpm: thresholdLpm,
    min_flow_lpm: rows.length ? Math.min(...rows.map((r) => Number(r.flow_lpm ?? 0))) : null,
    fault_seen: rows.some((r) => r.fault === true),
  };

  // Fresh data still shows the problem: the repair did not work.
  if (latest && lastAge <= 60_000 && isBad(latest)) return { result: 'failed' as const, summary };
  // Not enough fresh, healthy data yet (older bad readings may still be in the window).
  if (rows.length < 3 || spanMs < windowMs * 0.8 || lastAge > 60_000 || bad.length) {
    return { result: 'waiting_for_data' as const, summary };
  }
  return { result: 'verified' as const, summary };
}
