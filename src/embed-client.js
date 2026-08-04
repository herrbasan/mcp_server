import { getLogger } from './utils/logger.js';

const logger = getLogger();

/**
 * Embed client — talks DIRECTLY to the llama-cpp-wrapper, no gateway hop.
 *
 * Architecture (2026-08-04): the LLM Gateway was removed from the embed path
 * after the immortal-request incident (32 hung gateway-side promises: no
 * abort propagation, no body-read deadline on the gateway's embed route).
 * The wrapper + llama-server already provide the required semantics:
 *   - llama-server's slot queue serializes execution (slow, never broken)
 *   - the wrapper propagates client disconnects upstream, freeing slots
 * So the only failure modes left are: wrapper machine down (fetch fails
 * fast) or queue wait longer than the timeout (loud, caller retries).
 *
 * There is deliberately NO circuit breaker here. A breaker exists to paper
 * over hangs; with abort propagation the queue drains, so a breaker would
 * only add a stateful failure mode on top of a stateless service.
 *
 * Config (env or config.json gateway section):
 *   EMBED_URL    — wrapper base URL, e.g. http://192.168.0.145:4080
 *   EMBED_MODEL  — model field sent to the wrapper (it resolves the gguf),
 *                  e.g. Qwen/Qwen3-Embedding-4B-GGUF
 */

const EMBED_TIMEOUT_MS = 15000;
const EMBED_BATCH_TIMEOUT_MS = 30000;

export function createEmbedClient(embedUrl, embedModel) {
    if (!embedUrl) throw new Error('createEmbedClient: embedUrl is required (env EMBED_URL or config gateway.embedUrl)');
    if (!embedModel) throw new Error('createEmbedClient: embedModel is required (env EMBED_MODEL or config gateway.embedModel)');
    const baseUrl = embedUrl.replace(/\/+$/, '');

    async function post(body, timeoutMs) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
            const res = await fetch(`${baseUrl}/v1/embeddings`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
                signal: ctrl.signal
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
            return await res.json();
        } catch (err) {
            if (err.name === 'AbortError') {
                throw new Error(`Embedding timed out after ${timeoutMs / 1000}s — wrapper queue longer than timeout (retry is safe)`);
            }
            throw err;
        } finally {
            clearTimeout(timer);
        }
    }

    return {
        async embed(text) {
            const data = await post({ model: embedModel, input: text }, EMBED_TIMEOUT_MS);
            return data.data[0].embedding;
        },

        async embedBatch(texts) {
            const data = await post({ model: embedModel, input: texts }, EMBED_BATCH_TIMEOUT_MS);
            return data.data.map(d => d.embedding);
        }
    };
}
