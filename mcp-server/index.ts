import { MCPServer } from "mcp-use";
import { z } from "zod";

// Every tool is a thin wrapper around an InsForge edge function. All business
// rules (state machine, approvals, spend limits, payment checks) live in the
// backend, so agents cannot skip steps no matter how they call these tools.

const FUNCTIONS_URL =
  process.env.INSFORGE_FUNCTIONS_URL ?? "https://nden3esm.us-west.insforge.app/functions";
const AGENT_TOKEN = process.env.AGENT_API_TOKEN ?? "";

const server = new MCPServer({
  name: "plant-maintenance",
  title: "Plant Maintenance Operator",
  version: "1.0.0",
  description:
    "Take an industrial equipment incident from SCADA alarm to independently verified repair: " +
    "investigate, contact approved contractors, get human approval, pay, and verify recovery.",
  instructions: `You are working a maintenance incident for an industrial plant.

Workflow (each incident's allowed_next_actions tells you what is possible now):
1. get_active_incidents -> pick an incident.
2. investigate_incident -> diagnosis and the trade to dispatch.
3. request_technician_quotes -> emails approved contractors. Replies arrive asynchronously.
4. get_repair_status / compare_quotes -> wait until a complete quote exists.
5. request_manager_approval -> a HUMAN manager must approve the exact amount. You cannot approve.
6. create_authorized_payment -> only after approval exists. Returns a Stripe checkout link.
7. Once the technician finishes: report_repair with their report.
8. verify_recovery -> only plant data can close the incident. Call again if it says waiting_for_data.
Urgent: page_on_call_manager sends the manager an iMessage (no contractor reply, safety concern).

Rules: you have read-only access to plant signals and never control equipment.
Never claim a booking, approval, payment or repair happened unless a tool result says so.
If a tool returns an error, read error.code and error.hint and follow the hint.`,
});

type Json = Record<string, unknown>;

async function callFunction(slug: string, body: Json) {
  const res = await fetch(`${FUNCTIONS_URL}/${slug}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-agent-token": AGENT_TOKEN },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data: Json;
  try {
    data = JSON.parse(text);
  } catch {
    data = { ok: false, error: { code: "BAD_RESPONSE", message: text.slice(0, 500) } };
  }
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
    isError: !res.ok || data.ok === false,
  };
}

const incidentId = z.string().describe('Incident ID, e.g. "INC-101"');

server.tool(
  {
    name: "get_active_incidents",
    description:
      "List open maintenance incidents (anything not verified or cancelled), newest first, " +
      "with status and allowed_next_actions.",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async () => callFunction("incident-status", { action: "list_active" }),
);

server.tool(
  {
    name: "get_asset_context",
    description:
      "Get an asset's details (location, type, SCADA tags, healthy flow threshold), its latest " +
      "plant readings, and its incident history.",
    inputSchema: z.object({ asset_id: z.string().describe('Asset ID, e.g. "PUMP-101"') }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ asset_id }) => callFunction("incident-status", { action: "asset", asset_id }),
);

server.tool(
  {
    name: "investigate_incident",
    description:
      "Diagnose a newly detected incident from its alarm, tag snapshot, recent readings and asset " +
      "context. Records the diagnosis and the recommended trade. Safe to call twice.",
    inputSchema: z.object({ incident_id: incidentId }),
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ incident_id }) => callFunction("investigate-incident", { incident_id }),
);

server.tool(
  {
    name: "request_technician_quotes",
    description:
      "Email approved contractors who match the diagnosed trade, asking for price, earliest " +
      "arrival and scope. Requires a diagnosis. Replies are parsed into quotes automatically.",
    inputSchema: z.object({
      incident_id: incidentId,
      technician_ids: z.array(z.string()).optional()
        .describe("Optional: only contact these technicians"),
      max: z.number().int().min(1).max(5).optional().describe("Max contractors to contact (default 2)"),
    }),
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
  },
  async (args) => callFunction("request-quotes", args),
);

server.tool(
  {
    name: "compare_quotes",
    description:
      "Compare received quotes for an incident (complete quotes first, then price, then arrival) " +
      "and get a recommended quote_id.",
    inputSchema: z.object({ incident_id: incidentId }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ incident_id }) => callFunction("incident-status", { action: "compare_quotes", incident_id }),
);

server.tool(
  {
    name: "request_manager_approval",
    description:
      "Ask a human manager to approve a specific complete quote. This does NOT approve anything: " +
      "the incident waits in APPROVAL_PENDING until a signed-in manager approves the exact amount.",
    inputSchema: z.object({ incident_id: incidentId, quote_id: z.string() }),
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
  },
  async (args) => callFunction("request-approval", args),
);

server.tool(
  {
    name: "create_authorized_payment",
    description:
      "Create a Stripe test-mode checkout for exactly the amount a human manager approved. Fails " +
      "without an approval. Returns checkout_url; payment status updates automatically from Stripe.",
    inputSchema: z.object({
      approval_id: z.string().describe("Approval ID from get_repair_status (approvals[].id)"),
    }),
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ approval_id }) => callFunction("create-payment", { approval_id }),
);

server.tool(
  {
    name: "get_repair_status",
    description:
      "Full state of one incident: status, allowed_next_actions, diagnosis, contractor outreach, " +
      "quotes, approvals, payments, evidence and the timeline of who did what.",
    inputSchema: z.object({ incident_id: incidentId }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ incident_id }) => callFunction("incident-status", { incident_id }),
);

server.tool(
  {
    name: "report_repair",
    description:
      "Record the technician's repair report (and optional photo) once the scheduled work is done. " +
      "This is the technician's claim only; verify_recovery confirms it with plant data.",
    inputSchema: z.object({
      incident_id: incidentId,
      report: z.string().describe("What the technician found and did"),
      submitted_by: z.string().optional().describe("Technician name"),
      photo_url: z.string().url().optional(),
    }),
    annotations: { readOnlyHint: false, openWorldHint: false },
  },
  async (args) => callFunction("report-repair", args),
);

server.tool(
  {
    name: "verify_recovery",
    description:
      "Independently verify the repair from plant readings: flow must stay at or above the asset's " +
      "threshold with no fault for the observation window. Returns verified, failed, or " +
      "waiting_for_data (call again in ~15 seconds). Only a verified result closes the incident.",
    inputSchema: z.object({
      incident_id: incidentId,
      window_seconds: z.number().int().min(10).max(3600).optional()
        .describe("Observation window in seconds (default 30)"),
    }),
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
  },
  async (args) => callFunction("verify-recovery", args),
);

server.tool(
  {
    name: "page_on_call_manager",
    description:
      "Send an urgent iMessage to the on-call plant manager (Inkbox). Use when email is too slow: " +
      "no contractor reply, a safety concern, or a failed verification. escalate=true also hands the " +
      "incident to a human (ESCALATED). Approval and payment still happen on the approval page.",
    inputSchema: z.object({
      incident_id: incidentId,
      message: z.string().max(500).describe("Short, specific message for the manager"),
      escalate: z.boolean().optional().describe("Also mark the incident ESCALATED"),
    }),
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
  async (args) => callFunction("page-manager", args),
);

export default server;
