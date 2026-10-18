// Unit tests for the pure decision logic in functions/src/_logic.ts.
// Run: node --test functions/test/   (Node 22.18+ runs TypeScript directly)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  addressOf, incidentIdIn, rankQuotes, recoveryVerdict, regexQuote, ruleBasedDiagnosis,
  stripQuoted, toCents, verifyPrimitiveSignature,
} from '../src/_logic.ts';

// ---------------------------------------------------------------------------
// Webhook signatures

const SECRET = 'whsec_test';
const sign = (raw: string, t: number, secret = SECRET) =>
  `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex')}`;

test('signature: valid header passes', async () => {
  const raw = '{"event":"email.received"}';
  const now = 1_800_000_000;
  assert.equal(await verifyPrimitiveSignature(raw, sign(raw, now), SECRET, now), true);
});

test('signature: tampered body, wrong secret, stale or missing header fail', async () => {
  const raw = '{"event":"email.received"}';
  const now = 1_800_000_000;
  assert.equal(await verifyPrimitiveSignature(raw + ' ', sign(raw, now), SECRET, now), false);
  assert.equal(await verifyPrimitiveSignature(raw, sign(raw, now, 'other'), SECRET, now), false);
  assert.equal(await verifyPrimitiveSignature(raw, sign(raw, now - 301), SECRET, now), false);
  assert.equal(await verifyPrimitiveSignature(raw, null, SECRET, now), false);
  assert.equal(await verifyPrimitiveSignature(raw, 't=abc,v1=00', SECRET, now), false);
  assert.equal(await verifyPrimitiveSignature(raw, sign(raw, now), '', now), false);
});

// ---------------------------------------------------------------------------
// Contractor replies

test('addressOf extracts and lowercases the address', () => {
  assert.equal(addressOf('Alex Rivera <Alex@Rivera.example>'), 'alex@rivera.example');
  assert.equal(addressOf(' sam@chen.example '), 'sam@chen.example');
});

test('stripQuoted keeps only the new reply', () => {
  const text = 'I can do it for $450 tomorrow 9am.\n\nOn Fri, Oct 17, 2026 Agent wrote:\n> Please quote';
  assert.equal(stripQuoted(text), 'I can do it for $450 tomorrow 9am.');
  assert.equal(stripQuoted('Price $90\n> quoted line'), 'Price $90');
});

test('incidentIdIn finds the incident in subject or body', () => {
  assert.equal(incidentIdIn('Re: [INC-104] Repair quote request', ''), 'INC-104');
  assert.equal(incidentIdIn('Re: quote', 'about INC-7 thanks'), 'INC-7');
  assert.equal(incidentIdIn('no id', 'here'), undefined);
});

test('regexQuote reads a price and never invents an arrival time', () => {
  const q = regexQuote('Callout and seal replacement: $1,250.50 total.');
  assert.equal(q.amount_usd, 1250.5);
  assert.equal(q.available_at, null);
  assert.deepEqual(q.missing, ['available_at']);
  assert.deepEqual(regexQuote('Will call you.').missing, ['amount_usd', 'available_at']);
});

test('toCents rejects zero, negative and non-numeric amounts', () => {
  assert.equal(toCents(180), 18000);
  assert.equal(toCents('12.345'), 1235);
  assert.equal(toCents(0), null);
  assert.equal(toCents(-5), null);
  assert.equal(toCents('free'), null);
  assert.equal(toCents(null), null);
});

// ---------------------------------------------------------------------------
// Quote ranking

test('rankQuotes: complete before incomplete, then cheapest, then earliest; rejected dropped', () => {
  const ranked = rankQuotes([
    { id: 'cheap-incomplete', amount_cents: 100, is_complete: false, status: 'received' },
    { id: 'pricey', amount_cents: 50000, available_at: '2026-10-18T09:00:00Z', is_complete: true, status: 'received' },
    { id: 'cheap-late', amount_cents: 30000, available_at: '2026-10-19T09:00:00Z', is_complete: true, status: 'received' },
    { id: 'cheap-early', amount_cents: 30000, available_at: '2026-10-18T08:00:00Z', is_complete: true, status: 'received' },
    { id: 'rejected', amount_cents: 1, is_complete: true, status: 'rejected' },
  ]);
  assert.deepEqual(ranked.map((q) => q.quote_id), ['cheap-early', 'cheap-late', 'pricey', 'cheap-incomplete']);
  assert.equal(ranked[0].amount, '$300.00');
});

// ---------------------------------------------------------------------------
// Diagnosis fallback

test('ruleBasedDiagnosis: running pump with no flow and a fault needs a pump tech', () => {
  const d = ruleBasedDiagnosis({ tag_snapshot: { run_cmd: true, flow: 0, fault: true } }, []);
  assert.equal(d.recommended_trade, 'pump');
  const other = ruleBasedDiagnosis({ tag_snapshot: { run_cmd: false, flow: 0, fault: false } }, []);
  assert.equal(other.recommended_trade, 'mechanical');
});

// ---------------------------------------------------------------------------
// Recovery verdict

const NOW = Date.parse('2026-10-17T12:00:00Z');
const at = (secsAgo: number) => new Date(NOW - secsAgo * 1000).toISOString();
const healthy = (secsAgo: number) => ({ flow_lpm: 120, fault: false, recorded_at: at(secsAgo) });
const faulty = (secsAgo: number) => ({ flow_lpm: 0, fault: true, recorded_at: at(secsAgo) });
const opts = { windowMs: 30_000, thresholdLpm: 50, now: NOW };

test('recovery: a full window of healthy readings verifies', () => {
  const { result, summary } = recoveryVerdict([healthy(30), healthy(20), healthy(10), healthy(2)], opts);
  assert.equal(result, 'verified');
  assert.equal(summary.observed_seconds, 28);
});

test('recovery: a fresh faulty reading fails', () => {
  assert.equal(recoveryVerdict([healthy(30), healthy(20), faulty(2)], opts).result, 'failed');
});

test('recovery: low flow without a fault bit still fails', () => {
  const lowFlow = { flow_lpm: 10, fault: false, recorded_at: at(1) };
  assert.equal(recoveryVerdict([healthy(30), healthy(20), lowFlow], opts).result, 'failed');
});

test('recovery: waits when data is short, stale, or an old bad reading is still in the window', () => {
  assert.equal(recoveryVerdict([], opts).result, 'waiting_for_data');
  assert.equal(recoveryVerdict([healthy(6), healthy(4), healthy(2)], opts).result, 'waiting_for_data');
  assert.equal(recoveryVerdict([healthy(200), healthy(150), healthy(90)], opts).result, 'waiting_for_data');
  assert.equal(recoveryVerdict([faulty(30), healthy(20), healthy(10), healthy(2)], opts).result, 'waiting_for_data');
});

test('recovery: a stale faulty reading does not fail the repair (waits instead)', () => {
  assert.equal(recoveryVerdict([healthy(200), faulty(90)], opts).result, 'waiting_for_data');
});
