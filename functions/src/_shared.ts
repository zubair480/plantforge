// Shared helpers for every maintenance edge function.
// scripts/build-functions.mjs inlines this file into each function before deploy,
// because InsForge deploys one self-contained file per function.

import { createAdminClient, createClient } from 'npm:@insforge/sdk';

export const env = (name: string, fallback?: string): string => {
  const v = Deno.env.get(name) ?? fallback;
  if (v === undefined) throw new Error(`missing secret ${name}`);
  return v;
};

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers':
    'Content-Type, Authorization, x-agent-token, x-plant-token, Primitive-Signature',
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

// Errors are written for agents: a stable code, what went wrong, and what to do next.
export function fail(status: number, code: string, message: string, hint?: string, extra?: object): Response {
  return json({ ok: false, error: { code, message, hint, ...extra } }, status);
}

export function adminDb() {
  return createAdminClient({ baseUrl: env('INSFORGE_BASE_URL'), apiKey: env('API_KEY') }).database;
}

export function adminClient() {
  return createAdminClient({ baseUrl: env('INSFORGE_BASE_URL'), apiKey: env('API_KEY') });
}

export async function readJson(req: Request): Promise<Record<string, any>> {
  if (req.method === 'GET') return Object.fromEntries(new URL(req.url).searchParams);
  try {
    return (await req.json()) ?? {};
  } catch {
    return {};
  }
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Shared-secret header check for machine callers (MCP server, Ignition). */
export function checkToken(req: Request, header: string, secretName: string): Response | null {
  const expected = Deno.env.get(secretName);
  if (!expected) return fail(500, 'SERVER_MISCONFIGURED', `secret ${secretName} is not set`);
  const got = req.headers.get(header) ?? '';
  if (!safeEqual(got, expected)) {
    return fail(401, 'UNAUTHORIZED', `missing or invalid ${header} header`);
  }
  return null;
}

export function isAgent(req: Request): boolean {
  const expected = Deno.env.get('AGENT_API_TOKEN');
  return !!expected && safeEqual(req.headers.get('x-agent-token') ?? '', expected);
}

/** Signed-in human manager (InsForge Auth token) who is listed in public.managers. */
export async function getManager(req: Request) {
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!token) return { error: fail(401, 'LOGIN_REQUIRED', 'a signed-in manager is required') };
  const userClient = createClient({ baseUrl: env('INSFORGE_BASE_URL'), accessToken: token } as any);
  const { data: userData } = await userClient.auth.getCurrentUser();
  const user = userData?.user;
  if (!user?.id) return { error: fail(401, 'LOGIN_REQUIRED', 'invalid or expired login') };
  const { data: mgr } = await adminDb().from('managers').select('*').eq('user_id', user.id).maybeSingle();
  if (!mgr) {
    return { error: fail(403, 'NOT_A_MANAGER', 'this user is not authorized to approve maintenance spend') };
  }
  return { user, manager: mgr, userClient };
}

export async function loadIncident(id: string) {
  const { data, error } = await adminDb().from('incidents').select('*').eq('id', id).maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

/**
 * Move an incident from one status to the next. The database trigger rejects
 * illegal transitions; the `from` check makes concurrent calls safe.
 */
export async function transition(
  id: string,
  from: string | string[],
  to: string,
  actor: string,
  note?: string,
  extra: Record<string, unknown> = {},
) {
  const froms = Array.isArray(from) ? from : [from];
  const { data, error } = await adminDb()
    .from('incidents')
    .update({ ...extra, status: to, last_actor: actor, last_note: note ?? null })
    .eq('id', id)
    .in('status', froms)
    .select();
  if (error) throw new Error(error.message);
  if (!data?.length) throw new Error(`incident ${id} is not in ${froms.join('/')} (cannot move to ${to})`);
  return data[0];
}

export async function logEvent(incidentId: string, actor: string, detail: string) {
  await adminDb().from('incident_events').insert([{ incident_id: incidentId, actor, detail }]);
}

/** What an agent may do next for an incident in a given status. */
export const NEXT_ACTIONS: Record<string, string[]> = {
  DETECTED: ['investigate_incident'],
  DIAGNOSED: ['request_technician_quotes'],
  QUOTES_REQUESTED: ['wait for contractor replies, then get_repair_status'],
  QUOTE_RECEIVED: ['compare_quotes', 'request_manager_approval'],
  APPROVAL_PENDING: ['wait for a human manager to approve on the approval page'],
  APPROVED: ['create_authorized_payment'],
  PAID: ['wait for scheduling'],
  SCHEDULED: ['wait for the technician, then report_repair'],
  REPAIR_REPORTED: ['verify_recovery'],
  VERIFYING: ['verify_recovery (call again after plant readings arrive)'],
  VERIFICATION_FAILED: ['request_technician_quotes or escalate'],
  VERIFIED: [],
  ESCALATED: ['a human operator is handling this incident'],
  CANCELLED: [],
};

export function withNext(incident: any) {
  return { ...incident, allowed_next_actions: NEXT_ACTIONS[incident.status] ?? [] };
}

/** Ask the model for a JSON object. Returns null on any failure so callers can fall back. */
export async function llmJson(system: string, user: string): Promise<Record<string, any> | null> {
  const key = Deno.env.get('OPENROUTER_API_KEY');
  if (!key) return null;
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: Deno.env.get('OPENROUTER_CHAT_MODEL') ?? 'anthropic/claude-sonnet-5.5',
        response_format: { type: 'json_object' },
        temperature: 0,
        max_tokens: 800,
        messages: [
          { role: 'system', content: system + '\nRespond with a single JSON object only.' },
          { role: 'user', content: user },
        ],
      }),
    });
    if (!res.ok) {
      console.error('llm error', res.status, await res.text());
      return null;
    }
    const out = await res.json();
    const text: string = out.choices?.[0]?.message?.content ?? '';
    const match = text.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : null;
  } catch (e) {
    console.error('llm failure', e);
    return null;
  }
}

/** Send an email through Primitive. */
export async function sendEmail(opts: { to: string; subject: string; text: string; idempotencyKey: string }) {
  const res = await fetch('https://api.primitive.dev/v1/send-mail', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env('PRIMITIVE_API_KEY')}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': opts.idempotencyKey,
    },
    body: JSON.stringify({
      from: Deno.env.get('PRIMITIVE_FROM') ?? 'agent@loud-dove.primitive.email',
      to: opts.to,
      subject: opts.subject,
      body_text: opts.text,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`primitive send failed (${res.status}): ${JSON.stringify(body?.error ?? body)}`);
  }
  return body?.data ?? body;
}

/**
 * Urgent alert to the on-call manager by iMessage through Inkbox.
 * Never throws: email (Primitive) remains the system of record, this is the pager.
 */
export async function pageManager(incidentId: string, text: string) {
  const key = Deno.env.get('INKBOX_API_KEY');
  const to = Deno.env.get('MANAGER_PHONE');
  if (!key || !to) return { sent: false, reason: 'INKBOX_API_KEY or MANAGER_PHONE not set' };
  try {
    const res = await fetch('https://inkbox.ai/api/v1/imessage/messages', {
      method: 'POST',
      headers: { 'X-API-Key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_identity_id: Deno.env.get('INKBOX_IDENTITY_ID') ?? undefined,
        to,
        text,
      }),
    });
    const body = await res.json().catch(() => ({}));
    const ok = res.ok;
    await logEvent(incidentId, 'inkbox',
      ok ? `Paged on-call manager by iMessage: ${text.slice(0, 120)}`
        : `iMessage page failed (${res.status}): ${JSON.stringify(body?.detail ?? body).slice(0, 200)}`);
    return { sent: ok, status: res.status };
  } catch (e) {
    return { sent: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

export const dollars = (cents: number | null | undefined) =>
  cents == null ? null : `$${(cents / 100).toFixed(2)}`;

/** Standard wrapper: CORS, method check, and agent-readable crash errors. */
export function handler(fn: (req: Request) => Promise<Response>) {
  return async (req: Request): Promise<Response> => {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
    try {
      return await fn(req);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const illegal = /not in|illegal incident transition/.test(message);
      return fail(illegal ? 409 : 500, illegal ? 'INVALID_STATE' : 'INTERNAL_ERROR', message,
        illegal ? 'Call get_repair_status to see the current status and allowed_next_actions.' : undefined);
    }
  };
}
