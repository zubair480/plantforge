// Minimal MCP client over Streamable HTTP: initialize, list tools, call one or more tools.
//   node scripts/smoke-test.mjs [mcpUrl] [toolName] [jsonArgs]
// Default: lists tools and calls get_active_incidents on http://localhost:3000/mcp

const [url = 'http://localhost:3000/mcp', tool = 'get_active_incidents', args = '{}'] = process.argv.slice(2);
let session;
let id = 0;

async function rpc(method, params, notify = false) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(session ? { 'mcp-session-id': session } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', method, params, ...(notify ? {} : { id: ++id }) }),
  });
  session = res.headers.get('mcp-session-id') ?? session;
  if (notify) return null;
  const text = await res.text();
  // Responses may come as JSON or as a single SSE "data:" event.
  const payload = text.trim().startsWith('{')
    ? text
    : text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5)).pop();
  const msg = JSON.parse(payload);
  if (msg.error) throw new Error(`${method}: ${JSON.stringify(msg.error)}`);
  return msg.result;
}

const init = await rpc('initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'smoke-test', version: '1.0.0' },
});
console.log('server:', init.serverInfo.name, '| instructions:', init.instructions ? 'yes' : 'no');
await rpc('notifications/initialized', {}, true);

const { tools } = await rpc('tools/list', {});
console.log(`tools (${tools.length}):`, tools.map((t) => t.name).join(', '));

const result = await rpc('tools/call', { name: tool, arguments: JSON.parse(args) });
console.log(`\n${tool} -> isError=${!!result.isError}`);
console.log(result.content?.[0]?.text);
