import { randomUUID } from 'crypto';
import { getLogger } from './utils/logger.js';

const logger = getLogger();

export function createGatewayClient(wsUrl, httpUrl, embedModel, models = {}) {
    let ws = null;
    let isClosed = false;
    let reconnectAttempts = 0;
    
    // Map<requestId, { resolve, reject, onDelta, response } >
    const pendingRequests = new Map();
    
    // Reference to the client object for use in closures
    let client = null;

    function summarizeText(text, maxLength = 120) {
        if (!text) return '';
        return text.length > maxLength ? `${text.slice(0, maxLength)}... [${text.length} chars]` : text;
    }

    function connect() {
        if (isClosed) return;
        
        logger.info(`Connecting to WebSocket: ${wsUrl}`, null, 'Gateway');
        ws = new WebSocket(wsUrl);

        ws.onopen = () => {
            logger.info('WebSocket connected', null, 'Gateway');
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
                            req.deltaCount = (req.deltaCount || 0) + 1;
                            req.totalChars = (req.totalChars || 0) + content.length;
                            const deltaMeta = {
                                requestId: request_id,
                                deltaCount: req.deltaCount,
                                totalChars: req.totalChars,
                                chunkChars: content.length,
                                elapsedMs: Date.now() - req.startedAt,
                                hasContent: Boolean(content)
                            };
                            if (content && !req.loggedFirstDelta) {
                                req.loggedFirstDelta = true;
                                logger.info(`[Gateway] First delta for ${request_id}`, {
                                    preview: summarizeText(content),
                                    chars: content.length
                                });
                            } else if (content && (req.deltaCount % 25 === 0)) {
                                logger.info(`[Gateway] Delta chunk ${req.deltaCount} for ${request_id}`, {
                                    totalChars: req.totalChars,
                                    chunkChars: content.length,
                                    preview: summarizeText(content, 60)
                                });
                            }
                            if (req.onDelta) { 
                                // Explicit check that it is being passed
                                req.onDelta(content, deltaMeta); 
                            }
                            if (content) req.response.content += content;
                            
                            // Hard client-side limits to prevent runaway generation
                            // Some models (Qwen) get stuck in infinite thinking loops with empty deltas
                            const MAX_EMPTY_DELTAS = 1000; // Max deltas with no content before we give up
                            const emptyDeltaThreshold = req.maxTokens ? Math.min(MAX_EMPTY_DELTAS, req.maxTokens) : MAX_EMPTY_DELTAS;
                            
                            if (req.hardLimit && req.totalChars > req.hardLimit) {
                                logger.warn(`[Gateway] Hard CHAR limit exceeded for ${request_id}: ${req.totalChars} chars > ${req.hardLimit}. Cancelling...`);
                                client.cancel(request_id);
                            } else if (req.deltaCount > emptyDeltaThreshold && req.totalChars === 0) {
                                // Detect infinite thinking loop (many deltas, zero output)
                                logger.error(`[Gateway] Infinite thinking detected for ${request_id}: ${req.deltaCount} deltas, 0 chars. Cancelling...`);
                                client.cancel(request_id);
                                // Force reject the promise to fail fast
                                req.reject(new Error(`Model stuck in infinite thinking loop (${req.deltaCount} empty deltas). Try again or use a different model.`));
                                pendingRequests.delete(request_id);
                            }
                        }
                    } else if (msg.method === 'chat.progress') {
                        const { request_id, phase, context } = msg.params;
                        const req = pendingRequests.get(request_id);
                        if (req && req.onProgress) {
                            req.onProgress(phase, context);
                        }
                    } else if (msg.method === 'chat.done') {
                        const { request_id, cancelled } = msg.params;
                        const req = pendingRequests.get(request_id);
                        if (req) {
                            logger.info(`[Gateway] chat.done for ${request_id}`, {
                                cancelled,
                                durationMs: Date.now() - req.startedAt,
                                deltaCount: req.deltaCount || 0,
                                totalChars: req.totalChars || 0
                            });
                            req.response.cancelled = cancelled;
                            req.resolve(req.response);
                            pendingRequests.delete(request_id);
                        }
                    } else if (msg.method === 'chat.error') {
                        const { request_id, error } = msg.params;
                        const req = pendingRequests.get(request_id);
                        if (req) {
                            logger.info(`[Gateway] chat.error for ${request_id}`, {
                                durationMs: Date.now() - req.startedAt,
                                deltaCount: req.deltaCount || 0,
                                totalChars: req.totalChars || 0,
                                error: error?.message || String(error)
                            });
                            req.reject(new Error(error?.message || String(error)));
                            pendingRequests.delete(request_id);
                        }
                    }
                    // chat.progress (routing, context_stats) - informational, no action needed
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
                logger.error('Failed to parse message:', err, null, 'Gateway');
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
            logger.info(`WebSocket disconnected. Reconnecting in ${delay}ms...`, null, 'Gateway');
            setTimeout(connect, delay);
        };

        ws.onerror = (err) => {
            // Error is handled mostly by close, just log
            logger.error('WebSocket error', err, null, 'Gateway');
        };
    }

    function send(msg) {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            throw new Error('Gateway WebSocket not connected');
        }
        ws.send(JSON.stringify(msg));
    }

    connect();

    client = {
        get connected() {
            return ws && ws.readyState === WebSocket.OPEN;
        },

        // Adapter for old router.predict() API used by codebase agent
        async predict({ prompt, systemPrompt, taskType, temperature, maxTokens, responseFormat }) {
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
                maxTokens,
                temperature,
                responseFormat: gatewayFormat
            });
            // Return parsed object if responseFormat is a schema, else string
            if (gatewayFormat?.type === 'json_schema') {
                // Parse JSON response, handling markdown fences
                let text = response.content || '';
                console.log('[DEBUG] response.content length:', text.length, 'preview:', text.slice(0, 100));
                // Find the first { and last } to extract JSON (handles any fences)
                const firstBrace = text.indexOf('{');
                const lastBrace = text.lastIndexOf('}');
                console.log('[DEBUG] firstBrace:', firstBrace, 'lastBrace:', lastBrace);
                if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
                    text = text.substring(firstBrace, lastBrace + 1);
                }
                console.log('[DEBUG] text to parse preview:', text.slice(0, 100));
                return JSON.parse(text);
            }
            return response.content;
        },

        async chat({ model, messages, systemPrompt, maxTokens, temperature, responseFormat, onDelta, onProgress }) {
            const id = randomUUID();
            // Prepend system prompt as a system message if provided
            const fullMessages = systemPrompt
                ? [{ role: 'system', content: systemPrompt }, ...messages]
                : messages;
            return new Promise((resolve, reject) => {
                pendingRequests.set(id, {
                    resolve,
                    reject,
                    onDelta,
                    onProgress,
                    response: { content: '' },
                    startedAt: Date.now(),
                    deltaCount: 0,
                    totalChars: 0,
                    loggedFirstDelta: false,
                    maxTokens: maxTokens || null,
                    hardLimit: maxTokens ? Math.floor(maxTokens * 4.5) : null // ~4.5 chars/token heuristic
                });
                try {
                    logger.info(`[Gateway] Sending chat.create for ${id}`, {
                        model,
                        messageCount: fullMessages.length,
                        promptChars: fullMessages.reduce((total, message) => total + (message.content?.length || 0), 0),
                        maxTokens: maxTokens,
                        stream: true,
                        hasResponseFormat: Boolean(responseFormat)
                    });
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
                            strip_thinking: true,
                            stream: true
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
    
    return client;
}
