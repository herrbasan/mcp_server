import { getLogger } from './utils/logger.js';

const logger = getLogger();

/**
 * LLM Gateway client — SSE transport.
 *
 * Talks to the gateway exclusively over HTTP REST:
 *   chat()        → POST /v1/chat/completions (stream: true, SSE)
 *   embed()       → POST /v1/embeddings
 *   listModels()  → GET /v1/models
 *
 * Cancellation uses AbortController; the gateway aborts the upstream
 * provider request when the client disconnects.
 *
 * The first argument (legacy wsUrl) is accepted for call-site compatibility
 * and ignored — the WS transport was removed from the gateway (2026-07-26).
 */
export function createGatewayClient(_wsUrl, httpUrl, accessKey) {
    const baseUrl = httpUrl.replace(/\/+$/, '');

    function authHeaders() {
        const headers = { 'Content-Type': 'application/json' };
        if (accessKey) {
            headers['Authorization'] = `Bearer ${accessKey}`;
        }
        return headers;
    }

    function summarizeText(text, maxLength = 120) {
        if (!text) return '';
        return text.length > maxLength ? `${text.slice(0, maxLength)}... [${text.length} chars]` : text;
    }

    async function chat({ task, model, messages, systemPrompt, maxTokens, temperature, responseFormat, enableThinking, onDelta, onProgress }) {
        const fullMessages = systemPrompt
            ? [{ role: 'system', content: systemPrompt }, ...messages]
            : messages;

        const body = {
            messages: fullMessages,
            stream: true,
            strip_thinking: true
        };
        if (maxTokens != null) body.max_tokens = maxTokens;
        if (temperature != null) body.temperature = temperature;
        if (responseFormat != null) body.response_format = responseFormat;
        if (enableThinking != null) body.enable_thinking = enableThinking;
        if (task) body.task = task;
        else if (model) body.model = model;

        logger.info('[Gateway] POST /v1/chat/completions', {
            task,
            model,
            messageCount: fullMessages.length,
            promptChars: fullMessages.reduce((total, message) => total + (message.content?.length || 0), 0),
            maxTokens,
            hasResponseFormat: Boolean(responseFormat)
        });

        const controller = new AbortController();
        const startedAt = Date.now();
        const response = { content: '', cancelled: false };

        const hardLimit = maxTokens ? Math.floor(maxTokens * 4.5) : null;
        let deltaCount = 0;
        let totalChars = 0;
        let loggedFirstDelta = false;
        let lastProgressLog = 0;
        let contextReported = false;

        let res;
        try {
            res = await fetch(`${baseUrl}/v1/chat/completions`, {
                method: 'POST',
                headers: authHeaders(),
                body: JSON.stringify(body),
                signal: controller.signal
            });
        } catch (err) {
            throw new Error(`Gateway connection failed: ${err.message}`);
        }

        if (!res.ok) {
            const errText = await res.text().catch(() => res.statusText);
            throw new Error(`Gateway error ${res.status}: ${errText}`);
        }

        const contentType = res.headers.get('content-type') || '';
        if (!contentType.includes('text/event-stream')) {
            const raw = await res.text();
            throw new Error(`Gateway returned non-SSE response (${contentType}): ${raw.slice(0, 300)}`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop();

                for (const line of lines) {
                    if (!line.startsWith('data:')) continue;
                    const data = line.slice(line.startsWith('data: ') ? 6 : 5).trim();
                    if (!data || data === '[DONE]') continue;

                    let chunk;
                    try {
                        chunk = JSON.parse(data);
                    } catch {
                        logger.warn('[Gateway] Unparseable SSE data line', { preview: data.slice(0, 200) }, 'Gateway');
                        continue;
                    }

                    if (chunk.error) {
                        const message = chunk.error.message || JSON.stringify(chunk.error);
                        const err = new Error(`Gateway stream error: ${message}`);
                        err.code = chunk.error.code;
                        throw err;
                    }

                    // Gateway context telemetry rides the finish_reason chunk.
                    // Reported once via onProgress — mid-stream phase events
                    // (routing/reasoning_started) died with the WS transport.
                    if (!contextReported && chunk.context && onProgress) {
                        contextReported = true;
                        onProgress('context_stats', chunk.context);
                    }

                    const choice = chunk.choices?.[0];
                    const content = choice?.delta?.content || '';
                    if (!content) continue;

                    deltaCount++;
                    totalChars += content.length;
                    response.content += content;

                    if (onDelta) {
                        onDelta(content, {
                            deltaCount,
                            totalChars,
                            chunkChars: content.length,
                            elapsedMs: Date.now() - startedAt,
                            hasContent: true
                        });
                    }

                    if (!loggedFirstDelta) {
                        loggedFirstDelta = true;
                        logger.info('[Gateway] First delta', {
                            preview: summarizeText(content),
                            chars: content.length
                        });
                    }

                    if (maxTokens) {
                        const pct = Math.floor((totalChars / (maxTokens * 4)) * 100);
                        const milestone = Math.floor(pct / 25) * 25;
                        if (milestone > lastProgressLog && milestone > 0 && milestone <= 75) {
                            lastProgressLog = milestone;
                            logger.info(`[Gateway] Stream at ${milestone}%`, { totalChars, deltaCount });
                        }
                    }

                    if (hardLimit && totalChars > hardLimit) {
                        logger.warn(`[Gateway] Hard CHAR limit exceeded: ${totalChars} chars > ${hardLimit}. Aborting...`);
                        response.cancelled = true;
                        controller.abort();
                    }
                }
            }
        } catch (err) {
            if (err.name === 'AbortError' && response.cancelled) {
                // Self-inflicted hard-limit abort — fall through to resolve below.
            } else {
                throw err;
            }
        }

        logger.info('[Gateway] chat complete', {
            cancelled: response.cancelled,
            durationMs: Date.now() - startedAt,
            deltaCount,
            totalChars
        });

        return response;
    }

    return {
        get connected() {
            return true; // HTTP is connectionless; kept for interface compatibility
        },

        chat,

        async predict({ prompt, systemPrompt, task, temperature, maxTokens, responseFormat }) {
            let gatewayFormat = responseFormat;
            if (responseFormat && !responseFormat.type) {
                gatewayFormat = {
                    type: 'json_schema',
                    json_schema: { name: 'response', strict: true, schema: responseFormat }
                };
            }
            const response = await chat({
                task,
                messages: [{ role: 'user', content: prompt }],
                systemPrompt,
                maxTokens,
                temperature,
                responseFormat: gatewayFormat
            });
            if (gatewayFormat?.type === 'json_schema') {
                const text = response.content || '';
                const firstBrace = text.indexOf('{');
                const lastBrace = text.lastIndexOf('}');
                if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
                    throw new Error(`Gateway predict: no JSON object in response (${text.length} chars)`);
                }
                return JSON.parse(text.substring(firstBrace, lastBrace + 1));
            }
            return response.content;
        },

        async embed(text, model) {
            const body = model
                ? { input: text, model }
                : { input: text, task: 'embed' };
            const res = await fetch(`${baseUrl}/v1/embeddings`, {
                method: 'POST',
                headers: authHeaders(),
                body: JSON.stringify(body)
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
            const data = await res.json();
            return data.data[0].embedding;
        },

        async embedText(text, model) {
            return this.embed(text, model);
        },

        async embedBatch(texts) {
            const res = await fetch(`${baseUrl}/v1/embeddings`, {
                method: 'POST',
                headers: authHeaders(),
                body: JSON.stringify({ input: texts, task: 'embed' })
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
            const data = await res.json();
            return data.data.map(d => d.embedding);
        },

        async listModels(type) {
            const url = type ? `${baseUrl}/v1/models?type=${encodeURIComponent(type)}` : `${baseUrl}/v1/models`;
            const res = await fetch(url, { headers: authHeaders() });
            if (!res.ok) throw new Error(`Gateway listModels failed: HTTP ${res.status} ${res.statusText}`);
            const data = await res.json();
            return data.data || [];
        },

        close() {
            // No persistent connection to close; per-request AbortControllers
            // die with their fetch.
        }
    };
}
