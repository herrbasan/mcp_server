// Full E2E: a real codereview.review call through the live MCP dispatcher.
// Target: the codereview agent's own source (dogfood — real code, 7 files).
const BASE = process.env.MCP_URL || 'http://127.0.0.1:3100';
const SOURCE = process.argv[2] || 'D:\\DEV\\mcp_server\\src\\agents\\codereview';
let sessionId = null;

async function rpc(method, params) {
    const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' };
    if (sessionId) headers['Mcp-Session-Id'] = sessionId;
    const res = await fetch(`${BASE}/mcp/compact`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', id: Math.random().toString(36).slice(2), method, params })
    });
    const newSession = res.headers.get('mcp-session-id');
    if (newSession) sessionId = newSession;
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const contentType = res.headers.get('content-type') || '';
    const raw = await res.text();
    if (contentType.includes('text/event-stream')) {
        const dataLine = raw.split('\n').filter((l) => l.startsWith('data:')).pop();
        return dataLine ? JSON.parse(dataLine.slice(5).trim()) : null;
    }
    return raw ? JSON.parse(raw) : null;
}

await rpc('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'codereview-e2e', version: '1.0.0' }
});
await rpc('notifications/initialized', {});

console.log(`reviewing: ${SOURCE}`);
const started = Date.now();
const result = await rpc('tools/call', {
    name: 'tools',
    arguments: { method: 'codereview.review', payload: { source: SOURCE, budget: { maxFiles: 10 } } }
});
const isError = result?.result?.isError === true;
const text = result?.result?.content?.[0]?.text ?? JSON.stringify(result).slice(0, 400);
if (isError) {
    console.error('REVIEW FAILED:', text);
    process.exitCode = 1;
} else {
    console.log(`done in ${((Date.now() - started) / 1000).toFixed(0)}s — report:\n`);
    console.log(text);
}
