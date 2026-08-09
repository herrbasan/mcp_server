import { getLogger } from './utils/logger.js';

const logger = getLogger();

/**
 * LLM Gateway client — SSE transport (chat only).
 *
 * Talks to the gateway exclusively over HTTP REST:
 *   chat()        → POST /v1/chat/completions (stream: true, SSE)
 *   listModels()  → GET /v1/models
 *
 * Cancellation uses AbortController; the gateway aborts the upstream
 * provider request when the client disconnects.
 *
 * The first argument (legacy wsUrl) is accepted for call-site compatibility
 * and ignored — the WS transport was removed from the gateway (2026-07-26).
 *
 * Embeds do NOT go through the gateway. Since 2026-08-04 they are delegated
 * to the embed client (src/embed-client.js), which talks directly to the
 * llama-cpp-wrapper. Background: the gateway's embed route leaked immortal
 * promises (no abort propagation, no body-read deadline); the wrapper +
 * llama-server already provide queueing and disconnect semantics, so the
 * gateway hop added only failure modes. No circuit breaker here — a breaker
 * papers over hangs, and hangs are now impossible by construction.
 */

export function createGatewayClient(_wsUrl, httpUrl, accessKey, embedClient) {
    if (!embedClient) throw new Error('createGatewayClient: embedClient is required');
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

        async predict({ prompt, systemPrompt, task, temperature, maxTokens, responseFormat, enableThinking }) {
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
                responseFormat: gatewayFormat,
                enableThinking
            });
            if (gatewayFormat?.type === 'json_schema' || gatewayFormat?.type === 'json_object') {
                // response may be an already-parsed object (upstream honored
                // the format) or a raw string containing JSON (model ignored
                // the hint and emitted plain text). Handle both.
                if (response.content != null && typeof response.content === 'object') {
                    return response.content;
                }
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

        // Embeds: delegated to the direct wrapper client (see header).
        async embed(text, opts) {
            return embedClient.embed(text, opts);
        },

        async embedText(text, opts) {
            return embedClient.embed(text, opts);
        },

        async embedBatch(texts, opts) {
            return embedClient.embedBatch(texts, opts);
        },

        // Background embeds (store/heal): generous deadlock-guard timeout — let
        // the wrapper queue work them off instead of aborting at the foreground cap.
        async embedBackground(text) {
            return embedClient.embed(text, { background: true });
        },

        async embedBatchBackground(texts) {
            return embedClient.embedBatch(texts, { background: true });
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
