import { createClient } from '@insforge/sdk';

// Manager approval page: sign in, review the quote the agent selected,
// approve or reject the exact amount, then pay through Stripe Checkout.
// All rules are enforced by the approve-quote and create-payment functions.

const insforge = createClient({
  baseUrl: import.meta.env.VITE_INSFORGE_URL,
  anonKey: import.meta.env.VITE_INSFORGE_ANON_KEY,
});

type Row = Record<string, any>;

const app = document.getElementById('app')!;
const who = document.getElementById('who')!;
const params = new URLSearchParams(location.search);

const state: {
  user: Row | null;
  isManager: boolean;
  incidents: Row[];
  selected: string | null;
  detail: Row | null;
  message: { kind: 'ok' | 'error'; text: string } | null;
  busy: boolean;
  otpEmail: string | null;
} = {
  user: null,
  isManager: false,
  incidents: [],
  selected: params.get('incident'),
  detail: null,
  message: params.get('paid') ? { kind: 'ok', text: 'Payment submitted. Waiting for Stripe confirmation…' } : null,
  busy: false,
  otpEmail: null,
};

const esc = (v: unknown) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const money = (cents?: number | null) => (cents == null ? '—' : `$${(cents / 100).toFixed(2)}`);
const when = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

const STATUS_TONE: Record<string, string> = {
  APPROVAL_PENDING: 'wait', APPROVED: 'wait', PAID: 'ok', SCHEDULED: 'ok', VERIFIED: 'ok',
  VERIFICATION_FAILED: 'warn', ESCALATED: 'warn', DETECTED: 'warn',
};
const chip = (status: string) => `<span class="chip ${STATUS_TONE[status] ?? ''}">${esc(status.replace(/_/g, ' '))}</span>`;

// ---------------------------------------------------------------------------
// Data

async function loadSession() {
  const { data } = await insforge.auth.getCurrentUser();
  state.user = data?.user ?? null;
  if (state.user) {
    const { data: mgr } = await insforge.database.from('managers').select('user_id').eq('user_id', state.user.id).maybeSingle();
    state.isManager = !!mgr;
  }
}

async function loadIncidents() {
  const { data } = await insforge.database
    .from('incidents')
    .select('id, asset_id, status, alarm_message, updated_at')
    .not('status', 'in', '(VERIFIED,CANCELLED)')
    .order('updated_at', { ascending: false });
  // Incidents waiting on the manager first.
  state.incidents = (data ?? []).sort(
    (a: Row, b: Row) => Number(b.status === 'APPROVAL_PENDING') - Number(a.status === 'APPROVAL_PENDING'),
  );
  if (!state.selected && state.incidents.length) state.selected = state.incidents[0].id;
}

async function loadDetail(id: string) {
  const db = insforge.database;
  const [inc, quotes, approvals, payments, events] = await Promise.all([
    db.from('incidents').select('*, assets(name, location)').eq('id', id).maybeSingle(),
    db.from('quotes').select('*, technicians(name, company)').eq('incident_id', id).order('created_at'),
    db.from('approvals').select('*').eq('incident_id', id).order('created_at'),
    db.from('payments').select('*').eq('incident_id', id).order('created_at'),
    db.from('incident_events').select('*').eq('incident_id', id).order('created_at'),
  ]);
  state.detail = inc.data
    ? { incident: inc.data, quotes: quotes.data ?? [], approvals: approvals.data ?? [],
        payments: payments.data ?? [], events: events.data ?? [] }
    : null;
}

async function refresh() {
  if (!state.user) return render();
  await loadIncidents();
  if (state.selected) await loadDetail(state.selected);
  render();
}

async function callFunction(slug: string, body: Row): Promise<Row> {
  const { data, error } = await insforge.functions.invoke(slug, { body });
  if (error) {
    const e = error as Row;
    const detail = e.error?.message ?? e.response?.error?.message ?? e.message ?? 'Request failed';
    throw new Error(detail);
  }
  if (data?.ok === false) throw new Error(data.error?.message ?? 'Request failed');
  return data;
}

// ---------------------------------------------------------------------------
// Rendering

function renderSignIn() {
  app.className = 'single';
  who.innerHTML = '';
  app.innerHTML = `
    <div class="panel">
      <h2>Manager sign in</h2>
      <p class="meta">Approving maintenance spend requires a signed-in manager. We email you a 6-digit code.</p>
      ${state.otpEmail ? `
        <form id="otp-form">
          <label for="otp">Code sent to ${esc(state.otpEmail)}</label>
          <input id="otp" class="code-input" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required />
          <div class="actions">
            <button class="btn primary" ${state.busy ? 'disabled' : ''}>Sign in</button>
            <button type="button" class="btn" id="otp-back">Use another email</button>
          </div>
        </form>` : `
        <form id="email-form">
          <label for="email">Work email</label>
          <input id="email" type="email" autocomplete="email" required />
          <div class="actions"><button class="btn primary" ${state.busy ? 'disabled' : ''}>Email me a code</button></div>
        </form>`}
      ${messageHtml()}
    </div>`;

  document.getElementById('email-form')?.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const email = (document.getElementById('email') as HTMLInputElement).value.trim();
    await withBusy(async () => {
      const { error } = await insforge.auth.signInWithOtp({ email });
      if (error) throw new Error(error.message);
      state.otpEmail = email;
      state.message = null;
    });
  });
  document.getElementById('otp-form')?.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const otp = (document.getElementById('otp') as HTMLInputElement).value.trim();
    await withBusy(async () => {
      const { error } = await insforge.auth.verifyOtp({ email: state.otpEmail!, otp });
      if (error) throw new Error(error.message);
      state.message = null;
      await loadSession();
      await loadIncidents();
      if (state.selected) await loadDetail(state.selected);
    });
  });
  document.getElementById('otp-back')?.addEventListener('click', () => {
    state.otpEmail = null;
    render();
  });
}

function messageHtml() {
  return state.message ? `<div class="msg ${state.message.kind}" role="status">${esc(state.message.text)}</div>` : '';
}

function renderNotManager() {
  app.className = 'single';
  app.innerHTML = `
    <div class="panel">
      <h2>Not authorized</h2>
      <p>You are signed in as <strong>${esc(state.user!.email)}</strong>, but this account is not a maintenance manager.</p>
      <p class="meta">An admin can add you with:</p>
      <div class="note"><code>insert into public.managers (user_id, display_name, spend_limit_cents)
values ('${esc(state.user!.id)}', 'Plant Manager', 50000);</code></div>
      <div class="actions"><button class="btn" id="recheck">Check again</button></div>
    </div>`;
  document.getElementById('recheck')!.addEventListener('click', () => withBusy(loadSession));
}

function renderList() {
  if (!state.incidents.length) return `<p class="empty">No open incidents.</p>`;
  return `<div class="list">${state.incidents.map((i) => `
    <button class="item ${i.id === state.selected ? 'active' : ''}" data-id="${esc(i.id)}">
      <div class="item-top"><span class="item-id">${esc(i.id)}</span>${chip(i.status)}</div>
      <div class="item-sub">${esc(i.asset_id)} · ${esc(i.alarm_message ?? '')}</div>
    </button>`).join('')}</div>`;
}

function renderDecision(d: Row) {
  const { incident, quotes, approvals, payments } = d;
  const selected = quotes.find((q: Row) => q.status === 'selected');

  if (incident.status === 'APPROVAL_PENDING' && selected) {
    return `
      <div class="decision">
        <h2>Approval requested by the maintenance agent</h2>
        <div class="meta">${esc(selected.technicians?.name)} · ${esc(selected.technicians?.company)}</div>
        <div class="amount">${money(selected.amount_cents)}</div>
        <div>${esc(selected.scope)}</div>
        <div class="meta">Arrival: ${when(selected.available_at)}</div>
        <div class="actions">
          <button class="btn primary" id="approve" data-quote="${esc(selected.id)}" data-amount="${selected.amount_cents}"
            ${state.busy ? 'disabled' : ''}>Approve ${money(selected.amount_cents)}</button>
          <button class="btn danger" id="reject" data-quote="${esc(selected.id)}" ${state.busy ? 'disabled' : ''}>Reject</button>
        </div>
      </div>`;
  }

  const approval = approvals.findLast((a: Row) => a.decision === 'approved');
  const payment = payments.find((p: Row) => p.approval_id === approval?.id);
  if (incident.status === 'APPROVED' && approval) {
    return `
      <div class="decision">
        <h2>Approved — payment due</h2>
        <div class="amount">${money(approval.approved_amount_cents)}</div>
        <div class="meta">${payment ? 'Checkout started; waiting for Stripe confirmation.' : 'Pay the contractor through Stripe (test mode).'}</div>
        <div class="actions">
          <button class="btn primary" id="pay" data-approval="${esc(approval.id)}" ${state.busy ? 'disabled' : ''}>
            ${payment ? 'Open checkout again' : `Pay ${money(approval.approved_amount_cents)}`}</button>
        </div>
      </div>`;
  }

  if (payment?.status === 'paid') {
    return `<div class="note">Paid ${money(payment.amount_cents)} on ${when(payment.paid_at)}.
      ${incident.scheduled_for ? `Technician scheduled for ${when(incident.scheduled_for)}.` : ''}</div>`;
  }
  return `<div class="note meta">Nothing needs your decision right now.</div>`;
}

function renderDetail() {
  const d = state.detail;
  if (!d) return `<p class="empty">Select an incident.</p>`;
  const { incident, quotes, events } = d;
  return `
    <div class="head">
      <div>
        <div class="meta">${esc(incident.assets?.location)}</div>
        <h3>${esc(incident.id)} · ${esc(incident.assets?.name ?? incident.asset_id)}</h3>
      </div>
      ${chip(incident.status)}
    </div>

    ${messageHtml()}
    ${renderDecision(d)}

    <section>
      <h2>Alarm and diagnosis</h2>
      <div><strong>${esc(incident.alarm_message ?? incident.alarm_id)}</strong></div>
      <div class="grid2">
        ${Object.entries(incident.tag_snapshot ?? {}).map(([k, v]) =>
          `<div class="kv"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`).join('')}
        <div class="kv"><div class="k">detected</div><div class="v">${when(incident.detected_at)}</div></div>
        <div class="kv"><div class="k">trade</div><div class="v">${esc(incident.recommended_trade ?? '—')}</div></div>
      </div>
      ${incident.diagnosis ? `<div class="note">${esc(incident.diagnosis)}</div>` : ''}
    </section>

    <section>
      <h2>Quotes</h2>
      ${quotes.length ? `<div class="table-wrap"><table>
        <thead><tr><th>Contractor</th><th>Price</th><th>Arrival</th><th>Scope</th><th></th></tr></thead>
        <tbody>${quotes.map((q: Row) => `<tr>
          <td>${esc(q.technicians?.name)}<div class="meta">${esc(q.technicians?.company)}</div></td>
          <td class="num">${money(q.amount_cents)}</td>
          <td class="num">${when(q.available_at)}</td>
          <td>${esc(q.scope ?? '')}${q.is_complete ? '' : ' <span class="chip warn">incomplete</span>'}</td>
          <td>${q.status === 'received' ? '' : chip(q.status.toUpperCase())}</td>
        </tr>`).join('')}</tbody></table></div>` : `<p class="empty">No quotes yet.</p>`}
    </section>

    <section>
      <h2>Timeline</h2>
      <ul class="timeline">${events.map((e: Row) => `
        <li><span class="t">${time(e.created_at)}</span>
          <span><span class="actor">${esc(e.actor)}</span>
          ${e.to_status ? ` → ${esc(e.to_status)}` : ''}${e.detail ? ` · ${esc(e.detail)}` : ''}</span></li>`).join('')}
      </ul>
    </section>`;
}

function renderMain() {
  app.className = '';
  who.innerHTML = `<span>${esc(state.user!.email)}</span><button class="link" id="signout">Sign out</button>`;
  app.innerHTML = `
    <aside class="panel"><h2>Open incidents</h2>${renderList()}</aside>
    <div class="panel">${renderDetail()}</div>`;

  document.getElementById('signout')!.addEventListener('click', async () => {
    await insforge.auth.signOut();
    Object.assign(state, { user: null, isManager: false, detail: null, otpEmail: null });
    render();
  });
  app.querySelectorAll<HTMLButtonElement>('.item').forEach((b) =>
    b.addEventListener('click', async () => {
      state.selected = b.dataset.id!;
      state.message = null;
      history.replaceState(null, '', `?incident=${state.selected}`);
      await loadDetail(state.selected);
      render();
    }));

  document.getElementById('approve')?.addEventListener('click', (ev) => {
    const b = ev.currentTarget as HTMLButtonElement;
    withBusy(async () => {
      await callFunction('approve-quote', {
        quote_id: b.dataset.quote, decision: 'approved', amount_cents: Number(b.dataset.amount),
      });
      state.message = { kind: 'ok', text: 'Approved. You can now pay the contractor.' };
      await refreshData();
    });
  });
  document.getElementById('reject')?.addEventListener('click', (ev) => {
    const b = ev.currentTarget as HTMLButtonElement;
    withBusy(async () => {
      await callFunction('approve-quote', { quote_id: b.dataset.quote, decision: 'rejected' });
      state.message = { kind: 'ok', text: 'Rejected. The agent will look for another quote.' };
      await refreshData();
    });
  });
  document.getElementById('pay')?.addEventListener('click', (ev) => {
    const b = ev.currentTarget as HTMLButtonElement;
    withBusy(async () => {
      const here = `${location.origin}${location.pathname}?incident=${state.selected}`;
      const res = await callFunction('create-payment', {
        approval_id: b.dataset.approval, success_url: `${here}&paid=1`, cancel_url: here,
      });
      if (res.payment?.checkout_url) location.assign(res.payment.checkout_url);
      else state.message = { kind: 'ok', text: 'Payment already completed.' };
    });
  });
}

function render() {
  if (!state.user) return renderSignIn();
  if (!state.isManager) return renderNotManager();
  renderMain();
}

async function refreshData() {
  await loadIncidents();
  if (state.selected) await loadDetail(state.selected);
}

async function withBusy(fn: () => Promise<void>) {
  state.busy = true;
  render();
  try {
    await fn();
  } catch (e) {
    state.message = { kind: 'error', text: e instanceof Error ? e.message : String(e) };
  } finally {
    state.busy = false;
    render();
  }
}

loadSession().then(refresh);

// The agent and Stripe change incidents in the background; keep the view current.
setInterval(() => {
  if (state.user && state.isManager && !state.busy) refresh();
}, 5000);
