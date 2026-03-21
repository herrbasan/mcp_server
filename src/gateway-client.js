import { randomUUID } from 'crypto';

export function createGatewayClient(wsUrl, httpUrl, embedModel, models = {}) {
    let ws = null;
    let isClosed = false;
    let reconnectAttempts = 0;
    
    // Map<requestId, { resolve, reject, onDelta, response } >
    const pendingRequests = new Map();

    function connect() {
        if (isClosed) return;
        
        console.log(`[Gateway] Connecting to WebSocket: ${wsUrl}`);
        ws = new WebSocket(wsUrl);

        ws.onopen = () => {
            console.log('[Gateway] WebSocket connected');
            reconnectAttempts = 0;
        };

        ws.onmessage = (event) => {
            try {
                const msg = JSON.parse(event.data);

                // Handle JSON-RPC notifications from server
                if (msg.method) {
                    if (msg.method === 'chat.delta') {
                        const { request_id, choices } = msg.params;
                        const req = pendingRequests.get(request_id);
                        if (req) {
                            const content = choices?.[0]?.delta?.content || '';
                            if (content) req.response.content += content;
                            if (req.onDelta) req.onDelta(content);
                        }
                    } else if (msg.method === 'chat.done') {
                        const { request_id, cancelled } = msg.params;
                        const req = pendingRequests.get(request_id);
                        if (req) {
                            req.response.cancelled = cancelled;
                            req.resolve(req.response);
                            pendingRequests.delete(request_id);
                        }
                    } else if (msg.method === 'chat.error') {
                        const { request_id, error } = msg.params;
                        const req = pendingRequests.get(request_id);
                        if (req) {
                            req.reject(new Error(error?.message || String(error)));
                            pendingRequests.delete(request_id);
                        }
                    }
                    // chat.progress (routing, context_stats) — informational, no action needed
                }
                
                // Handle direct JSON-RPC error responses (e.g. bad request before stream starts)
                if (msg.id && !msg.method && msg.error) {
                    const req = pendingRequests.get(msg.id);
                    if (req) {
                        req.reject(new Error(msg.error.message || 'Unknown RPC error'));
                        pendingRequests.delete(msg.id);
                    }
                }
            } catch (err) {
                console.error('[Gateway] Failed to parse message:', err);
            }
        };

        ws.onclose = () => {
            if (isClosed) return;
            // Reject all pending
            for (const [id, req] of pendingRequests.entries()) {
                req.reject(new Error('WebSocket disconnected'));
            }
            pendingRequests.clear();

            const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
            reconnectAttempts++;
            console.log(`[Gateway] WebSocket disconnected. Reconnecting in ${delay}ms...`);
            setTimeout(connect, delay);
        };

        ws.onerror = (err) => {
            // Error is handled mostly by close, just log
            console.error('[Gateway] WebSocket error');
        };
    }

    function send(msg) {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            throw new Error('Gateway WebSocket not connected');
        }
        ws.send(JSON.stringify(msg));
    }

    connect();

    return {
        get connected() {
            return ws && ws.readyState === WebSocket.OPEN;
        },

        // Adapter for old router.predict() API used by codebase agent
        async predict({ prompt, systemPrompt, taskType, temperature, responseFormat }) {
            const model = models[taskType] || models.query || 'default';
            // Wrap raw JSON Schema objects into gateway format
            let gatewayFormat = responseFormat;
            if (responseFormat && !responseFormat.type) {
                gatewayFormat = {
                    type: 'json_schema',
                    json_schema: { name: 'response', strict: true, schema: responseFormat }
                };
            }
            const response = await this.chat({
                model,
                messages: [{ role: 'user', content: prompt }],
                systemPrompt,
                temperature,
                responseFormat: gatewayFormat
            });
            // Return parsed object if responseFormat is a schema, else string
            if (gatewayFormat?.type === 'json_schema') {
                const text = response.content.replace(/```json|```/g, '').trim();
                return JSON.parse(text);
            }
            return response.content;
        },

        async chat({ model, messages, systemPrompt, maxTokens, temperature, responseFormat, onDelta }) {
            const id = randomUUID();
            // Prepend system prompt as a system message if provided
            const fullMessages = systemPrompt
                ? [{ role: 'system', content: systemPrompt }, ...messages]
                : messages;
            return new Promise((resolve, reject) => {
                pendingRequests.set(id, { resolve, reject, onDelta, response: { content: '' } });
                try {
                    send({
                        jsonrpc: "2.0",
                        id,
                        method: "chat.create",
                        params: {
                            model,
                            messages: fullMessages,
                            max_tokens: maxTokens,
                            temperature,
                            response_format: responseFormat,
                            strip_thinking: true
                        }
                    });
                } catch (err) {
                    pendingRequests.delete(id);
                    reject(err);
                }
            });
        },

        async append({ model, message, onDelta }) {
            const id = randomUUID();
            return new Promise((resolve, reject) => {
                pendingRequests.set(id, { resolve, reject, onDelta, response: { content: '' } });
                try {
                    send({
                        jsonrpc: "2.0",
                        id,
                        method: "chat.append",
                        params: {
                            model,
                            message
                        }
                    });
                } catch (err) {
                    pendingRequests.delete(id);
                    reject(err);
                }
            });
        },

        cancel(requestId) {
            try {
                send({
                    jsonrpc: "2.0",
                    method: "chat.cancel",
                    params: { request_id: requestId }
                });
            } catch (err) {
                // Ignore if disconnected
            }
            const req = pendingRequests.get(requestId);
            if (req) {
                req.reject(new Error("Cancelled"));
                pendingRequests.delete(requestId);
            }
        },

        async embed(text) {
            const res = await fetch(`${httpUrl}/v1/embeddings`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ input: text, model: embedModel })
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
            const data = await res.json();
            return data.data[0].embedding;
        },

        async embedText(text) {
            return this.embed(text);
        },

        async embedBatch(texts) {
            const res = await fetch(`${httpUrl}/v1/embeddings`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ input: texts, model: embedModel })
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
            const data = await res.json();
            return data.data.map(d => d.embedding);
        },

        close() {
            isClosed = true;
            if (ws) {
                ws.close();
            }
            for (const req of pendingRequests.values()) {
                req.reject(new Error('Gateway client closed'));
            }
            pendingRequests.clear();
        }
    };
}
