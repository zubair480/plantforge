// Contract test for the live database rules. Read-only: it only calls the pure
// function incident_transition_allowed() and reads catalog tables.
// Needs a linked/logged-in InsForge CLI (or INSFORGE_ACCESS_TOKEN in CI).
//   node scripts/test-db-rules.mjs

import { execFileSync } from 'node:child_process';

const win = process.platform === 'win32';
const cli = (sql) => {
  // Windows needs a shell to run npx.cmd, so pass the SQL as one quoted argument there.
  const arg = win ? `"${sql.replace(/\s+/g, ' ').replace(/"/g, '\\"')}"` : sql;
  const out = execFileSync('npx', ['-y', '@insforge/cli', 'db', 'query', arg, '--json'], {
    encoding: 'utf8', shell: win,
  });
  // Output is { "rows": [...], "rowCount": n, ... }, possibly after npx notices.
  return JSON.parse(out.slice(out.indexOf('{'))).rows ?? [];
};

// [from, to, expected]
const cases = [
  // the happy path
  ['DETECTED', 'DIAGNOSED', true],
  ['DIAGNOSED', 'QUOTES_REQUESTED', true],
  ['QUOTES_REQUESTED', 'QUOTE_RECEIVED', true],
  ['QUOTE_RECEIVED', 'APPROVAL_PENDING', true],
  ['APPROVAL_PENDING', 'APPROVED', true],
  ['APPROVED', 'PAID', true],
  ['PAID', 'SCHEDULED', true],
  ['SCHEDULED', 'REPAIR_REPORTED', true],
  ['REPAIR_REPORTED', 'VERIFYING', true],
  ['VERIFYING', 'VERIFIED', true],
  // recovery paths
  ['APPROVAL_PENDING', 'QUOTE_RECEIVED', true], // manager rejected
  ['VERIFYING', 'VERIFICATION_FAILED', true],
  ['VERIFICATION_FAILED', 'SCHEDULED', true], // rework
  ['QUOTES_REQUESTED', 'ESCALATED', true],
  ['ESCALATED', 'QUOTES_REQUESTED', true],
  ['DIAGNOSED', 'CANCELLED', true],
  // the guardrails: no skipping approval, payment or verification
  ['QUOTE_RECEIVED', 'APPROVED', false],
  ['APPROVAL_PENDING', 'PAID', false],
  ['QUOTE_RECEIVED', 'PAID', false],
  ['APPROVED', 'SCHEDULED', false],
  ['SCHEDULED', 'VERIFIED', false],
  ['REPAIR_REPORTED', 'VERIFIED', false],
  ['DETECTED', 'VERIFIED', false],
  ['VERIFIED', 'ESCALATED', false],
  ['VERIFIED', 'DETECTED', false],
];

const values = cases.map(([f, t]) => `('${f}','${t}')`).join(',');
const rows = cli(`select f, t, public.incident_transition_allowed(f, t) as allowed from (values ${values}) v(f, t)`);
let failed = 0;
for (const [f, t, expected] of cases) {
  const row = rows.find((r) => r.f === f && r.t === t);
  const ok = row && (row.allowed === expected || String(row.allowed) === String(expected));
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${f} -> ${t}: expected ${expected ? 'allowed' : 'blocked'}, got ${row?.allowed}`);
}

// The guard triggers and manager-only reads must be in place.
const triggers = cli(`select tgname from pg_trigger where tgname in
  ('incidents_guard_status_upd','approvals_check_quote','payments_check_approval','fulfill_maintenance_payment_from_webhook')`);
const policies = cli(`select count(*)::int as n from pg_policies where schemaname='public' and policyname like '%_read_authenticated'`);
const checks = [
  ['all 4 guard triggers exist', triggers.length === 4],
  ['no table is readable by every signed-in user', Number(policies[0]?.n) === 0],
];
for (const [name, ok] of checks) {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
}

console.log(failed ? `\n${failed} check(s) failed` : `\nall ${cases.length + checks.length} database checks passed`);
process.exit(failed ? 1 : 0);
