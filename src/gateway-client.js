import { randomUUID } from 'crypto';
import { getLogger } from './utils/logger.js';

const logger = getLogger();

export function createGatewayClient(wsUrl, httpUrl) {
    let ws = null;
    let isClosed = false;
    let reconnectAttempts = 0;
    
    const pendingRequests = new Map();
    
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
                                req.onDelta(content, deltaMeta); 
                            }
                            if (content) req.response.content += content;
                            
                            const MAX_EMPTY_DELTAS = 1000;
                            const emptyDeltaThreshold = req.maxTokens ? Math.min(MAX_EMPTY_DELTAS, req.maxTokens) : MAX_EMPTY_DELTAS;
                            
                            if (req.hardLimit && req.totalChars > req.hardLimit) {
                                logger.warn(`[Gateway] Hard CHAR limit exceeded for ${request_id}: ${req.totalChars} chars > ${req.hardLimit}. Cancelling...`);
                                client.cancel(request_id);
                            } else if (req.deltaCount > emptyDeltaThreshold && req.totalChars === 0) {
                                logger.error(`[Gateway] Infinite thinking detected for ${request_id}: ${req.deltaCount} deltas, 0 chars. Cancelling...`);
                                client.cancel(request_id);
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
                }
                
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

        async predict({ prompt, systemPrompt, task, temperature, maxTokens, responseFormat }) {
            let gatewayFormat = responseFormat;
            if (responseFormat && !responseFormat.type) {
                gatewayFormat = {
                    type: 'json_schema',
                    json_schema: { name: 'response', strict: true, schema: responseFormat }
                };
            }
            const response = await this.chat({
                task,
                messages: [{ role: 'user', content: prompt }],
                systemPrompt,
                maxTokens,
                temperature,
                responseFormat: gatewayFormat
            });
            if (gatewayFormat?.type === 'json_schema') {
                let text = response.content || '';
                console.log('[DEBUG] response.content length:', text.length, 'preview:', text.slice(0, 100));
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

        async chat({ task, model, messages, systemPrompt, maxTokens, temperature, responseFormat, onDelta, onProgress }) {
            const id = randomUUID();
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
                    hardLimit: maxTokens ? Math.floor(maxTokens * 4.5) : null
                });
                try {
                    const logModel = task || model || 'unspecified';
                    logger.info(`[Gateway] Sending chat.create for ${id}`, {
                        task,
                        model,
                        messageCount: fullMessages.length,
                        promptChars: fullMessages.reduce((total, message) => total + (message.content?.length || 0), 0),
                        maxTokens: maxTokens,
                        stream: true,
                        hasResponseFormat: Boolean(responseFormat)
                    });
                    const params = {
                        messages: fullMessages,
                        max_tokens: maxTokens,
                        temperature,
                        response_format: responseFormat,
                        strip_thinking: true,
                        stream: true
                    };
                    if (task) {
                        params.task = task;
                    } else if (model) {
                        params.model = model;
                    }
                    send({
                        jsonrpc: "2.0",
                        id,
                        method: "chat.create",
                        params
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
                body: JSON.stringify({ input: text, task: 'embed' })
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
                body: JSON.stringify({ input: texts, task: 'embed' })
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
