const MCP_URL = process.env.MCP_URL || 'http://192.168.0.100:3100/mcp';

const parseResponseMessages = async (res) => {
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  if (ct.includes('application/json')) {
    try {
      const msg = await res.json();
      return msg ? [msg] : [];
    } catch {
      return [];
    }
  }

  const text = await res.text();
  const messages = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const data = line.slice('data: '.length).trim();
    if (!data) continue;
    try {
      messages.push(JSON.parse(data));
    } catch {
      // ignore non-JSON data lines
    }
  }
  return messages;
};

const postJsonRpc = async ({ sessionId, id, method, params, protocolVersion = '2024-11-05' }) => {
  const headers = {
    'content-type': 'application/json',
    'accept': 'application/json, text/event-stream',
    'mcp-protocol-version': protocolVersion,
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;

  const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });
  const res = await fetch(MCP_URL, { method: 'POST', headers, body });

  const newSessionId = res.headers.get('mcp-session-id') || sessionId || null;
  const messages = await parseResponseMessages(res);

  return { res, sessionId: newSessionId, messages };
};

const main = async () => {
  console.log(`[test-http-recall] MCP_URL=${MCP_URL}`);

  const init = await postJsonRpc({
    sessionId: null,
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'http-recall-test', version: '0.0.0' },
    },
  });

  console.log(`[initialize] http=${init.res.status} sessionId=${init.sessionId}`);
  const initMsg = init.messages.find(m => m.id === 1) || init.messages[0];
  if (!initMsg || initMsg.error) {
    console.error('[initialize] failed:', initMsg?.error || init.messages);
    process.exit(1);
  }

  await postJsonRpc({
    sessionId: init.sessionId,
    id: null,
    method: 'notifications/initialized',
    params: {},
  });

  const recall = await postJsonRpc({
    sessionId: init.sessionId,
    id: 2,
    method: 'tools/call',
    params: {
      name: 'recall',
      arguments: { query: 'SSEServerTransport', limit: 5 },
    },
  });

  const recallMsg = recall.messages.find(m => m.id === 2) || recall.messages[0];
  if (!recallMsg || recallMsg.error) {
    console.error('[recall] failed:', recallMsg?.error || recall.messages);
    process.exit(1);
  }

  console.log('[recall] ok');
  console.log(JSON.stringify(recallMsg.result, null, 2));
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
