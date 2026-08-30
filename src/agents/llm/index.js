import fs from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { getLogger } from '../../utils/logger.js';

const logger = getLogger();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Agents_Prime.md lives in storage under documentation/Workshop/ (the
// documentation agent was removed and docs became storage citizens). The
// storage root is required — no fallback to the deleted mcp_documentation/
// directory.
function resolvePrimePath(context) {
    const storageRoot = context?.config?.agents?.storage?.root;
    if (!storageRoot) throw new Error('llm.resolvePrimePath: agents.storage.root required — missing from config.json');
    return path.resolve(storageRoot, 'documentation', 'Workshop', 'Agents_Prime.md');
}

function loadPrinciples(context) {
    const primePath = resolvePrimePath(context);
    if (!fs.existsSync(primePath)) {
        logger.warn('[LLM Tool] Agents_Prime.md not found, falling back to default system prompt');
        return null;
    }
    const content = fs.readFileSync(primePath, 'utf8');
    const start = content.indexOf('## Principles');
    if (start === -1) {
        logger.warn('[LLM Tool] No ## Principles section found in Agents_Prime.md');
        return null;
    }
    // Find the next top-level section after ## Principles
    const end = content.indexOf('\n## ', start + 1);
    if (end === -1) {
        return content.slice(start).trim();
    }
    return content.slice(start, end).trim();
}

export async function query_model(args, context) {
    const { gateway, prompts, progress } = context;
    const { prompt, files = [], systemPrompt } = args;

    let fileContext = '';
    for (const file of files) {
        if (!fs.existsSync(file)) {
            return { content: [{ type: "text", text: `Error: File not found: ${file}` }], isError: true };
        }
        const content = fs.readFileSync(file, 'utf8');
        fileContext += `\n\n--- File: ${file} ---\n${content}\n--- End File ---\n`;
    }

    const finalPrompt = fileContext ? `${fileContext}\n\n${prompt}` : prompt;
    const primePrinciples = loadPrinciples(context);
    const sysPrompt = systemPrompt || primePrinciples || prompts.system;

    if (!sysPrompt) throw new Error('llm.query: no system prompt available');

    if (progress) progress('Querying LLM...', 10, 100);
    logger.debug(`[LLM Tool] Started query with prompt length ${finalPrompt.length}`);

    let receivedChars = 0;
    let lastPct = 10;
    let lastProgressTime = 0;
    let deltaEvents = 0;
    let firstGenerationSeen = false;

    function emitProgress(message, pct, force = false) {
        if (!progress) return;
        const now = Date.now();
        if (!force && now - lastProgressTime <= 250) return;
        if (!force && pct <= lastPct && now - lastProgressTime <= 1000) return;
        lastPct = Math.max(lastPct, pct);
        lastProgressTime = now;
        logger.debug(`[LLM Tool] Emitting progress: ${lastPct}% (${receivedChars} chars, ${deltaEvents} deltas)`);
        progress(message, lastPct, 100);
    }

    const response = await gateway.chat({
        task: 'query',
        messages: [{ role: 'user', content: finalPrompt }],
        systemPrompt: sysPrompt,
        onProgress: (phase, ctx) => {
            logger.debug(`[LLM Tool] Progress phase: ${phase}`, { ctx });
            if (progress) {
                if (phase === 'reasoning_started') {
                    progress('Model is thinking (stripping reasoning output)...', lastPct, 100);
                } else if (phase === 'routing') {
                    progress('Routing request to upstream...', lastPct, 100);
                } else if (phase === 'context_stats' && ctx) {
                    progress(`Context stats: ${ctx.used_tokens} used, ${ctx.available_tokens} avail`, lastPct, 100);
                } else {
                    progress(`Status: ${phase}`, lastPct, 100);
                }
            }
        },
        onDelta: (content, meta = {}) => {
            deltaEvents = meta.deltaCount || (deltaEvents + 1);
            if (content) receivedChars += content.length;
            if (!progress) return;

            if (!firstGenerationSeen) {
                firstGenerationSeen = true;
                emitProgress('Model started generating...', Math.max(lastPct, 15), true);
            }

            const basePct = Math.min(95, 15 + Math.floor(deltaEvents / 20));
            if (content) {
                const contentPct = Math.min(99, 20 + Math.floor(receivedChars / 100));
                const pct = Math.max(basePct, contentPct);
                emitProgress(`Receiving response (${receivedChars} chars, ${deltaEvents} deltas)...`, pct);
            } else {
                emitProgress(`Model generating... (${deltaEvents} deltas observed, no text yet)`, basePct);
            }
        }
    });

    logger.debug(`[LLM Tool] Finished. Total received characters: ${receivedChars}`);
    if (progress) progress('Done', 100, 100);

    return { content: [{ type: "text", text: response.content }] };
}

// ─── Pinned-model sessions (issue #13) ───────────────────────────────
// Long-lived conversations with a pinned model for repeated queries against
// an ingested file set (the cheap-model codebase-analyst pattern): load the
// codebase once, then query without re-reading per call. The Gateway stays
// stateless — session state is the stored message array, replayed per call.
// TTL is enforced lazily at access time; expired sessions vanish loudly.

const SESSION_TTL_MINUTES_DEFAULT = 60;
const SESSION_MAX_DEFAULT = 8;

// sessionId -> { id, model, systemPrompt, messages, createdAt, lastAccess }
const SESSIONS = new Map();

function sessionLimits(context) {
    const cfg = context?.config?.agents?.llm || {};
    return {
        ttlMs: (cfg.sessionTtlMinutes ?? SESSION_TTL_MINUTES_DEFAULT) * 60 * 1000,
        maxSessions: cfg.sessionMaxSessions ?? SESSION_MAX_DEFAULT
    };
}

function sweepExpiredSessions(ttlMs, now = Date.now()) {
    for (const [id, s] of SESSIONS) {
        if (now - s.lastAccess > ttlMs) {
            SESSIONS.delete(id);
            logger.info(`[LLM Tool] Session expired (TTL): ${id}`, null, 'LLM');
        }
    }
}

function requireSession(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
        throw new Error('llm.session: sessionId required (from llm.session_create)');
    }
    const session = SESSIONS.get(sessionId);
    if (!session) {
        throw new Error(`llm.session: unknown or expired session: ${sessionId} (create a new one with llm.session_create)`);
    }
    return session;
}

function sessionSummary(session) {
    return {
        sessionId: session.id,
        model: session.model,
        messages: session.messages.length,
        files_ingested: session.filesIngested,
        age_minutes: Math.round((Date.now() - session.createdAt) / 60000),
        idle_minutes: Math.round((Date.now() - session.lastAccess) / 60000)
    };
}

export async function llm_session_create(args, context) {
    const { model, files = [], systemPrompt } = args;
    if (typeof model !== 'string' || model.trim() === '') {
        throw new Error('llm.session_create: model required — pin a chat model (discover with gateway listModels)');
    }
    if (!Array.isArray(files)) {
        throw new Error('llm.session_create: files must be an array of absolute paths');
    }
    const limits = sessionLimits(context);
    sweepExpiredSessions(limits.ttlMs);
    if (SESSIONS.size >= limits.maxSessions) {
        throw new Error(`llm.session_create: session limit (${limits.maxSessions}) reached — close one with llm.session_close first`);
    }

    // Fail-fast model check: an unknown pin must die here, not at first query.
    const known = await context.gateway.listModels('chat');
    const knownIds = known.map(m => m.id ?? m);
    if (!knownIds.includes(model)) {
        throw new Error(`llm.session_create: unknown model "${model}" — available: ${knownIds.join(', ')}`);
    }

    const messages = [];
    for (const file of files) {
        if (typeof file !== 'string' || !fs.existsSync(file)) {
            throw new Error(`llm.session_create: file not found: ${file}`);
        }
        messages.push({ role: 'user', content: `--- File: ${file} ---\n${fs.readFileSync(file, 'utf8')}\n--- End File ---` });
        messages.push({ role: 'assistant', content: 'File ingested. Ready for queries.' });
    }

    const session = {
        id: `lls_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        model,
        systemPrompt: typeof systemPrompt === 'string' && systemPrompt.length > 0 ? systemPrompt : null,
        filesIngested: files.length,
        messages,
        createdAt: Date.now(),
        lastAccess: Date.now()
    };
    SESSIONS.set(session.id, session);
    logger.info(`[LLM Tool] Session created: ${session.id} (model: ${model}, files: ${files.length})`, null, 'LLM');

    return { content: [{ type: 'text', text: JSON.stringify(sessionSummary(session), null, 2) }] };
}

export async function llm_session_query(args, context) {
    const { sessionId, prompt, model } = args;
    if (typeof prompt !== 'string' || prompt.length === 0) {
        throw new Error('llm.session_query: prompt required');
    }
    const limits = sessionLimits(context);
    sweepExpiredSessions(limits.ttlMs);
    const session = requireSession(sessionId);

    // Per-call model overrides the pin for this call only (forge precedence
    // convention). The pin is never sent as a task — task would win over
    // model in gateway-client and silently break pinning.
    const pinned = typeof model === 'string' && model.length > 0 ? model : session.model;

    session.messages.push({ role: 'user', content: prompt });
    const chatArgs = { messages: session.messages };
    if (session.systemPrompt) chatArgs.systemPrompt = session.systemPrompt;
    chatArgs.model = pinned;

    const response = await context.gateway.chat(chatArgs);
    session.messages.push({ role: 'assistant', content: response.content });
    session.lastAccess = Date.now();

    return { content: [{ type: 'text', text: response.content }] };
}

export async function llm_session_close(args, context) {
    const { sessionId } = args;
    const session = requireSession(sessionId);
    SESSIONS.delete(session.id);
    logger.info(`[LLM Tool] Session closed: ${session.id}`, null, 'LLM');
    return { content: [{ type: 'text', text: `Closed session ${session.id} (model: ${session.model}, ${session.messages.length} messages in conversation).` }] };
}
