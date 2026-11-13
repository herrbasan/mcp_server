// Live wiring check for the codereview agent: streamable-HTTP MCP handshake
// against /mcp/compact, then methods.list (codereview.* registered?) and a
// harmless codereview.findings call through the real dispatcher.
const BASE = process.env.MCP_URL || 'http://127.0.0.1:3100';

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
        const dataLine = raw.split('\n').find((l) => l.startsWith('data:'));
        return dataLine ? JSON.parse(dataLine.slice(5).trim()) : null;
    }
    return raw ? JSON.parse(raw) : null;
}

const init = await rpc('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'codereview-live-check', version: '1.0.0' }
});
console.log('initialized:', init?.result?.serverInfo?.name ?? JSON.stringify(init).slice(0, 120));
await rpc('notifications/initialized', {});

const methods = await rpc('tools/call', { name: 'tools', arguments: { method: 'methods.list', payload: {} } });
const text = methods?.result?.content?.[0]?.text ?? '';
const codereviewLine = text.split('\n').find((l) => l.trim().startsWith('codereview'));
if (!codereviewLine || !/review/.test(codereviewLine) || !/accept/.test(codereviewLine)) {
    console.error('FAIL: no codereview methods in the live registry.');
    console.error(text.slice(0, 500));
    process.exitCode = 1;
} else {
    console.log('live methods:', codereviewLine.trim());

    const findings = await rpc('tools/call', { name: 'tools', arguments: { method: 'codereview.findings', payload: {} } });
    const findingsText = findings?.result?.content?.[0]?.text ?? '';
    console.log('codereview.findings →', findingsText.slice(0, 120));
    console.log('LIVE WIRING OK');
}
