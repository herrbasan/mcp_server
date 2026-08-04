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

// ── Embed provider circuit breaker (module-level, shared across instances) ──
// The Gateway routes embed calls to a remote wrapper; when that machine is
// unreachable every embed call would otherwise burn its full timeout. The
// circuit opens on the first failure so ALL consumers (memory recall, VDB
// scan/search, storage search) fail fast in milliseconds instead of each
// stalling. The window grows with consecutive failures (15s → 30s → … → 5 min)
// and resets on the first success.
let embedDownUntil = 0;
let embedBackoffMs = 15000;

function isEmbedProviderDown() {
    return Date.now() < embedDownUntil;
}

function markEmbedProviderDown() {
    embedDownUntil = Date.now() + embedBackoffMs;
    embedBackoffMs = Math.min(embedBackoffMs * 2, 5 * 60 * 1000);
}

function markEmbedProviderUp() {
    embedDownUntil = 0;
    embedBackoffMs = 15000;
}

function isEmbedNetworkError(err) {
    return err?.name === 'AbortError'
        || err?.name === 'TimeoutError'
        || err?.name === 'TypeError'                                  // fetch failed
        || (typeof err?.message === 'string' && /^HTTP 5\d\d/.test(err.message));
}

export function createGatewayClient(_wsUrl, httpUrl, accessKey) {
    const baseUrl = httpUrl.replace(/\/+$/, '');
    // Hard cap on embedding requests. The Gateway routes embed calls to a
    // remote wrapper (192.168.0.145:4080); if that machine is unreachable,
    // the fetch hangs indefinitely. This timeout ensures the calling tool
    // (memory.recall, VDB search) fails fast and degrades to recency
    // instead of blocking until the client's 2-minute tool timeout fires.
    const EMBED_TIMEOUT_MS = 15000;
    const EMBED_BATCH_TIMEOUT_MS = 30000;

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

        async embed(text) {
            if (isEmbedProviderDown()) {
                throw new Error('Embed provider down (circuit open) — retry later');
            }
            // The Gateway owns the embed model — clients never send model or
            // task. routeEmbedding pins the default embedding task's model
            // unconditionally (a wrong-dimension embed model would silently
            // corrupt the consuming VDB).
            const body = { input: text };
            // AbortController enforces a hard timeout. Without it, a hung
            // Gateway embed response blocks the calling tool indefinitely —
            // the memory agent's try/catch degrades to recency, but only
            // after the fetch eventually fails (which may be never).
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), EMBED_TIMEOUT_MS);
            try {
                const res = await fetch(`${baseUrl}/v1/embeddings`, {
                    method: 'POST',
                    headers: authHeaders(),
                    body: JSON.stringify(body),
                    signal: ctrl.signal
                });
                if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
                const data = await res.json();
                markEmbedProviderUp();
                return data.data[0].embedding;
            } catch (err) {
                if (isEmbedNetworkError(err)) markEmbedProviderDown();
                if (err.name === 'AbortError') {
                    throw new Error(`Embedding timed out after ${EMBED_TIMEOUT_MS / 1000}s — Gateway did not respond`);
                }
                throw err;
            } finally {
                clearTimeout(timer);
            }
        },

        async embedText(text) {
            return this.embed(text);
        },

        async embedBatch(texts) {
            if (isEmbedProviderDown()) {
                throw new Error('Embed provider down (circuit open) — retry later');
            }
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), EMBED_BATCH_TIMEOUT_MS);
            try {
                const res = await fetch(`${baseUrl}/v1/embeddings`, {
                    method: 'POST',
                    headers: authHeaders(),
                    body: JSON.stringify({ input: texts }),
                    signal: ctrl.signal
                });
                if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
                const data = await res.json();
                markEmbedProviderUp();
                return data.data.map(d => d.embedding);
            } catch (err) {
                if (isEmbedNetworkError(err)) markEmbedProviderDown();
                if (err.name === 'AbortError') {
                    throw new Error(`Embedding batch timed out after ${EMBED_BATCH_TIMEOUT_MS / 1000}s — Gateway did not respond`);
                }
                throw err;
            } finally {
                clearTimeout(timer);
            }
        },

        // Circuit breaker introspection — lets consumers (e.g. VDB's own
        // batch path) fail fast and share one outage signal.
        isEmbedProviderDown,
        markEmbedProviderDown,
        markEmbedProviderUp,

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
