import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getLogger } from '../../utils/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const logger = getLogger();

const DATA_DIR = join(__dirname, '..', '..', '..', 'data');
const MAP_PATH = join(DATA_DIR, 'dream_map.json');
const DISTILLATE_PATH = join(DATA_DIR, 'dream_distillate.json');
const MAPS_DIR = join(DATA_DIR, 'dream_maps');

let gateway = null;
let prompts = null;
let memoryAgent = null;
let agentConfig = {};
let scheduler = null;
let lastRunAt = null;
let isRunning = false;

// Approximate token count (chars / 4 for English-heavy text)
function tokenEstimate(text) {
    return Math.ceil(text.length / 4);
}

// Lenient JSON parser — handles common LLM output issues
function parseJsonLenient(text, fullText) {
    // Try raw parse first
    try { return JSON.parse(text); } catch (e) {
        logger.warn(`[Dreaming] Raw JSON parse failed: ${e.message}`, null, 'Dream');
    }

    // Save raw output for debugging
    const debugPath = join(DATA_DIR, 'dream_raw_output.json');
    writeFileSync(debugPath, text);
    logger.info(`[Dreaming] Saved extracted JSON (${text.length} chars) to ${debugPath} for inspection`, null, 'Dream');

    // Also save the FULL response content if available and different from extracted
    if (fullText && fullText !== text && fullText.length > text.length) {
        const fullDebugPath = join(DATA_DIR, 'dream_raw_output_full.json');
        writeFileSync(fullDebugPath, fullText);
        logger.info(`[Dreaming] Saved FULL response (${fullText.length} chars) to ${fullDebugPath} for inspection`, null, 'Dream');
    }

    // Repair strategies
    let repaired = text;
    repaired = repaired.replace(/\/\/.*$/gm, '');
    repaired = repaired.replace(/\/\*[\s\S]*?\*\//g, '');
    repaired = repaired.replace(/,\s*([}\]])/g, '$1');
    repaired = repaired.replace(/\]\s*\[/g, '],[');
    repaired = repaired.replace(/\}\s*\{/g, '},{');

    try { return JSON.parse(repaired); } catch (e) {
        logger.warn(`[Dreaming] Repair attempt 1 failed: ${e.message}`, null, 'Dream');
    }

    // Fix unquoted keys
    repaired = repaired.replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1"$2":');
    try { return JSON.parse(repaired); } catch (e) {
        logger.warn(`[Dreaming] Repair attempt 2 failed: ${e.message}`, null, 'Dream');
    }

    // Truncation recovery: close any open arrays/objects
    let closed = repaired;
    const openBrackets = (closed.match(/\[/g) || []).length;
    const closeBrackets = (closed.match(/\]/g) || []).length;
    const openBraces = (closed.match(/\{/g) || []).length;
    const closeBraces = (closed.match(/\}/g) || []).length;
    // Remove last incomplete element (partial object/string)
    closed = closed.replace(/,?\s*\{?[^"\]}]*$/, '');
    // Close open structures
    for (let i = 0; i < openBrackets - closeBrackets; i++) closed += ']';
    for (let i = 0; i < openBraces - closeBraces; i++) closed += '}';
    try { return JSON.parse(closed); } catch (e) {
        logger.warn(`[Dreaming] Truncation recovery failed: ${e.message}`, null, 'Dream');
    }

    // Last resort: extract just the nodes array and build a minimal map
    const nodesMatch = repaired.match(/"nodes"\s*:\s*\[([\s\S]*?)\]\s*\}/);
    if (nodesMatch) {
        try {
            const nodes = JSON.parse('[' + nodesMatch[1] + ']');
            return { meta: { version: '3.0', generated_at: new Date().toISOString() }, nodes, clusters: [], bridges: [], wildcards: [] };
        } catch {}
    }

    throw new Error(`Failed to parse dreamer JSON output (${text.length} chars). First 200 chars: ${text.substring(0, 200)}`);
}

// Load JSON with fallback
function loadJson(path, fallback = null) {
    if (!existsSync(path)) return fallback;
    return JSON.parse(readFileSync(path, 'utf-8'));
}

function saveJson(path, data) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(data, null, 2));
}

// Rotate map backups (keep last 5)
function rotateBackup() {
    if (!existsSync(MAP_PATH)) return;
    mkdirSync(MAPS_DIR, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = join(MAPS_DIR, `dream_map_${ts}.json`);
    writeFileSync(backup, readFileSync(MAP_PATH));
    // Prune to 5
    const backups = readdirSync(MAPS_DIR)
        .filter(f => f.startsWith('dream_map_') && f.endsWith('.json'))
        .sort();
    while (backups.length > 5) {
        const old = join(MAPS_DIR, backups.shift());
        import('fs').then(fs => fs.unlinkSync(old));
    }
}

// Format a single memory for LLM consumption
function formatMemory(m) {
    const parts = [`[#${m.id}] [${m.category}] conf:${(m.confidence ?? 0.5).toFixed(1)}`];
    parts.push(m.description);
    if (m.data) parts.push(`Extended: ${m.data}`);
    return parts.join('\n');
}

// ─── Phase 1: Distillation ───

async function distill(allMemories, previousDistillate, contextBudget) {
    const distillerPrompt = prompts.distiller;
    if (!distillerPrompt) throw new Error('Distiller prompt not loaded');

    // Find what changed since last distillation
    // Compare each memory's timestamp against when it was last distilled
    const distilledSnapshot = previousDistillate?.meta?.snapshot || {};
    let changedMemories = allMemories;
    let cachedDistillate = '';
    let cacheHitRatio = 0;

    if (previousDistillate?.content && Object.keys(distilledSnapshot).length > 0) {
        // A memory needs re-distillation if it's new or its timestamp changed since last distillation
        const changed = allMemories.filter(m => distilledSnapshot[m.id] !== m.timestamp);
        const unchanged = allMemories.filter(m => distilledSnapshot[m.id] === m.timestamp);

        if (changed.length === 0) {
            // Nothing changed — reuse entire distillate
            logger.info('[Dreaming] No new/updated memories since last distillation, using cache', null, 'Dream');
            return {
                content: previousDistillate.content,
                stats: {
                    total_memories: allMemories.length,
                    distilled_chunks: previousDistillate.meta.distilled_chunks,
                    cache_hit_ratio: 1.0
                }
            };
        }

        // Partial cache hit — reuse distillate for older, re-distill changed
        cachedDistillate = previousDistillate.content;
        changedMemories = changed;
        cacheHitRatio = unchanged.length / allMemories.length;
        logger.info(`[Dreaming] Partial cache: ${unchanged.length} cached, ${changed.length} new/updated to distill`, null, 'Dream');
    }

    // Chunk memories to fit context budget
    const maxChunkTokens = contextBudget - tokenEstimate(distillerPrompt) - 2000; // reserve for output
    const chunks = [];
    let currentChunk = '';
    let chunkCount = 0;

    for (const m of changedMemories) {
        const entry = formatMemory(m) + '\n\n';
        if (tokenEstimate(currentChunk + entry) > maxChunkTokens && currentChunk) {
            chunks.push(currentChunk);
            currentChunk = entry;
        } else {
            currentChunk += entry;
        }
    }
    if (currentChunk) chunks.push(currentChunk);

    // Distill each chunk
    const distilledParts = [];
    for (let i = 0; i < chunks.length; i++) {
        logger.info(`[Dreaming] Distilling chunk ${i + 1}/${chunks.length} (${tokenEstimate(chunks[i])} tokens)`, null, 'Dream');
        const response = await gateway.chat({
            task: agentConfig.distillerTask || 'query',
            messages: [{ role: 'user', content: distillerPrompt + chunks[i] }],
            systemPrompt: 'You are a memory compression agent. Output plain text only. Preserve all facts and IDs.',
            temperature: 0.3
        });
        distilledParts.push(response.content);
        chunkCount++;
    }

    // Merge: cached + new distillate
    const fullDistillate = [cachedDistillate, ...distilledParts].filter(Boolean).join('\n\n');

    return {
        content: fullDistillate,
        stats: {
            total_memories: allMemories.length,
            distilled_chunks: chunkCount,
            cache_hit_ratio: cacheHitRatio
        }
    };
}

// ─── Phase 2: Dreaming ───

// Merge a delta patch from the dreamer into the previous map.
// Pure computation — no LLM calls. Carries forward unchanged nodes,
// applies add/update/remove operations for nodes, clusters, and bridges.
function mergeDelta(delta, previousMap) {
    const nodeMap = new Map();
    const clusterMap = new Map();
    let bridges = [];
    let wildcards = [];
    let meta = { ...previousMap.meta };
    let recallDirective = previousMap.recall_directive;

    // Seed with previous map's data
    for (const node of previousMap.nodes || []) {
        nodeMap.set(node.id, { ...node });
    }
    for (const cluster of previousMap.clusters || []) {
        clusterMap.set(cluster.id, { ...cluster });
    }
    bridges = (previousMap.bridges || []).map(b => ({ ...b }));

    // Apply cluster changes
    for (const change of delta.cluster_changes || []) {
        if (change.op === 'add' || change.op === 'update') {
            clusterMap.set(change.cluster.id, { ...change.cluster });
        }
    }

    // Apply bridge changes
    for (const change of delta.bridge_changes || []) {
        if (change.op === 'add') {
            bridges.push({ ...change.bridge });
        } else if (change.op === 'remove') {
            bridges = bridges.filter(b =>
                !(b.from_id === change.bridge.from_id && b.to_id === change.bridge.to_id)
            );
        }
    }

    // Apply node changes
    let nodesAdded = 0;
    let nodesUpdated = 0;
    for (const change of delta.node_changes || []) {
        if (change.op === 'add') {
            nodeMap.set(change.node.id, { ...change.node });
            nodesAdded++;
        } else if (change.op === 'update') {
            const existing = nodeMap.get(change.node.id);
            if (existing) {
                nodeMap.set(change.node.id, { ...existing, ...change.node });
                nodesUpdated++;
            }
        }
    }

    // Replace wildcards entirely if provided
    if (delta.wildcards) {
        wildcards = delta.wildcards;
    } else {
        wildcards = previousMap.wildcards || [];
    }

    // Update meta
    if (delta.meta) {
        meta = { ...meta, ...delta.meta };
        meta.version = '3.0';
        meta.generated_at = new Date().toISOString();
    }
    if (delta.recall_directive) {
        recallDirective = delta.recall_directive;
    }

    logger.info(`[Dreaming] Merge: ${nodesAdded} added, ${nodesUpdated} updated, ${nodeMap.size} total nodes`, null, 'Dream');

    return {
        meta,
        clusters: [...clusterMap.values()],
        bridges,
        wildcards,
        nodes: [...nodeMap.values()],
        recall_directive: recallDirective
    };
}

// Compact a map that exceeds the token budget by dropping low-value nodes.
// Keeps: all cluster hubs, all bridges, all wildcards, nodes above scoreFloor.
// Compresses remaining nodes to title-only state (id + cluster_id + score).
function compactMap(map, maxTokens) {
    const nodes = map.nodes || [];
    const estimate = (obj) => Math.ceil(JSON.stringify(obj).length / 4);

    if (estimate(map) <= maxTokens) return map;

    logger.info(`[Dreaming] Map exceeds budget (${estimate(map)} tokens > ${maxTokens}), compacting...`, null, 'Dream');

    const hubIds = new Set((map.clusters || []).map(c => c.hub_id));
    const bridgeIds = new Set();
    for (const b of map.bridges || []) {
        bridgeIds.add(b.from_id);
        bridgeIds.add(b.to_id);
    }
    const wildcardIds = new Set((map.wildcards || []).map(w => w.id));

    const kept = [];
    const dropped = [];
    const SCORE_FLOOR = 0.25;

    for (const node of nodes) {
        const isHub = hubIds.has(node.id);
        const isBridge = bridgeIds.has(node.id) || node.is_bridge;
        const isWildcard = wildcardIds.has(node.id);
        const score = node.score ?? 0.3;

        if (isHub || isBridge || isWildcard || score >= 0.5) {
            kept.push(node);
        } else if (score >= SCORE_FLOOR) {
            // Compress to minimal fields
            kept.push({
                id: node.id,
                state: 'title',
                category: node.category,
                score: node.score,
                cluster_id: node.cluster_id
            });
        } else {
            dropped.push(node.id);
        }
    }

    logger.info(`[Dreaming] Compaction: kept ${kept.length}, dropped ${dropped.length} nodes`, null, 'Dream');

    return {
        ...map,
        nodes: kept
    };
}

async function dream(distillate, recentMemories, previousMap, contextBudget) {
    // Delta mode: if we have a previous map, only ask the dreamer for changes.
    // Full mode: no previous map, generate from scratch.
    const hasPreviousMap = previousMap?.nodes && previousMap.nodes.length > 0;
    const dreamerPrompt = hasPreviousMap ? (prompts['dreamer-delta'] || prompts.dreamer) : prompts.dreamer;
    if (!dreamerPrompt) throw new Error('Dreamer prompt not loaded');

    let input = '';

    if (hasPreviousMap) {
        // DELTA MODE: send the full previous map + only new memories
        input += '=== EXISTING MAP ===\n';
        input += JSON.stringify({
            meta: { generated_at: previousMap.meta?.generated_at },
            clusters: previousMap.clusters,
            bridges: previousMap.bridges,
            nodes: previousMap.nodes.map(n => ({
                id: n.id,
                state: n.state,
                summary: n.summary,
                category: n.category,
                score: n.score,
                connections: n.connections,
                cluster_id: n.cluster_id,
                is_bridge: n.is_bridge,
                momentum: n.momentum
            }))
        }, null, 2);
        input += '\n\n';

        if (recentMemories.length > 0) {
            input += '=== NEW/UPDATED MEMORIES (since last dream) ===\n';
            for (const m of recentMemories) {
                input += formatMemory(m) + '\n\n';
            }
        }
    } else {
        // FULL MODE: send distillate + recent memories (original behavior)
        if (distillate) {
            input += '=== DISTILLED HISTORY ===\n';
            input += distillate;
            input += '\n\n';
        }

        if (recentMemories.length > 0) {
            input += '=== FULL RECENT MEMORIES (since last dream) ===\n';
            for (const m of recentMemories) {
                input += formatMemory(m) + '\n\n';
            }
        }
    }

    // Check if input fits budget
    const promptTokens = tokenEstimate(dreamerPrompt);
    const inputTokens = tokenEstimate(input);
    const totalNeeded = promptTokens + inputTokens + 4000;

    if (totalNeeded > contextBudget) {
        logger.warn(`[Dreaming] Input (${inputTokens} tokens) + prompt (${promptTokens}) exceeds budget (${contextBudget}). Truncating.`, null, 'Dream');
        const maxInputTokens = contextBudget - promptTokens - 4000;
        if (maxInputTokens > 0) {
            input = input.slice(0, maxInputTokens * 4);
        }
    }

    logger.info(`[Dreaming] Running dreamer (${hasPreviousMap ? 'DELTA' : 'FULL'} mode, ${inputTokens} tokens input, ${promptTokens} prompt)`, null, 'Dream');

    const response = await gateway.chat({
        task: agentConfig.dreamerTask || 'query',
        messages: [{ role: 'user', content: dreamerPrompt + input }],
        systemPrompt: 'You are a memory topology agent. Output ONLY valid JSON. No markdown. No code blocks.',
        maxTokens: hasPreviousMap ? 16000 : 64000,
        temperature: 0.3,
        enableThinking: false
    });

    // Parse the JSON response with repair
    const fullContent = response.content || '';
    logger.info(`[Dreaming] Dreamer response: ${fullContent.length} chars`, null, 'Dream');

    // Strip ``` fences
    let mapText = fullContent
        .replace(/^```(?:json)?\s*\n?/gm, '')
        .replace(/\n?```\s*$/gm, '');

    // Extract outermost JSON object by tracking brace depth
    const firstBrace = mapText.indexOf('{');
    if (firstBrace !== -1) {
        let depth = 0;
        let lastBrace = -1;
        for (let i = firstBrace; i < mapText.length; i++) {
            const ch = mapText[i];
            if (ch === '{') depth++;
            else if (ch === '}') {
                depth--;
                if (depth === 0) { lastBrace = i; break; }
            }
        }
        if (lastBrace !== -1) {
            mapText = mapText.substring(firstBrace, lastBrace + 1);
        }
    }
    logger.info(`[Dreaming] Brace extraction: ${fullContent.length} chars → ${mapText.length} chars`, null, 'Dream');

    const parsed = parseJsonLenient(mapText, fullContent);

    if (hasPreviousMap) {
        // DELTA MODE: merge the patch into the previous map
        if (!parsed.node_changes && !parsed.cluster_changes && !parsed.bridge_changes) {
            // Model may have output a full map instead of a delta — detect and handle
            if (parsed.nodes && Array.isArray(parsed.nodes)) {
                logger.info('[Dreaming] Delta mode but model output full map — using as-is', null, 'Dream');
                const map = parsed;
                map.meta = map.meta || {};
                map.meta.version = '3.0';
                map.meta.generated_at = new Date().toISOString();
                return map;
            }
            throw new Error('Dreamer delta output missing required fields (node_changes, cluster_changes, bridge_changes)');
        }

        const merged = mergeDelta(parsed, previousMap);

        // Compact if the merged map exceeds budget
        const MAX_MAP_TOKENS = 120000; // ~480K chars — leaves room for growth
        return compactMap(merged, MAX_MAP_TOKENS);
    } else {
        // FULL MODE: use the output directly (original behavior)
        if (!parsed.meta || !parsed.nodes || !Array.isArray(parsed.nodes)) {
            throw new Error('Dreamer output missing required fields (meta, nodes)');
        }

        parsed.meta.version = '3.0';
        parsed.meta.generated_at = new Date().toISOString();
        return parsed;
    }
}

// ─── Phase 2b: Serendipity Injection ───
// Post-dream stochastic "sauce" — expands wildcards with random dormant nodes,
// applies small score jitter to mid-tier nodes, and tags everything so the
// consumer LLM knows what was surfaced randomly vs. by score.
//
// This runs AFTER the LLM produces its deterministic map. The LLM's structural
// decisions (clusters, bridges, node states) are preserved — we only add noise
// to what gets *surfaced*, not to the topology itself.

// Seeded PRNG (mulberry32) — reproducible when seed is set, true random otherwise
function createRng(seed) {
    const s = seed ?? Math.floor(Math.random() * 0xFFFFFFFF);
    let a = s >>> 0;
    return function () {
        a |= 0; a = a + 0x6D2B79F5 | 0;
        let t = Math.imul(a ^ a >>> 15, 1 | a);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

function applySerendipity(map, allMemories, previousMap, config) {
    if (!config || config.enabled === false) {
        return { injected: 0, resurfaced: 0, jittered: 0, floored: 0, seed: null };
    }

    const rng = createRng(config.seed);
    const stats = { injected: 0, resurfaced: 0, jittered: 0, floored: 0, seed: config.seed };
    const nodes = map.nodes || [];
    if (nodes.length === 0) return stats;

    // --- Score Floor Enforcement (deterministic, not random) ---
    // No valid memory should sit at 0.0. Clamp anything below floor up to floor.
    // This is the "gradual fade" guarantee — memories fade to dormant (0.15),
    // never to dead (0.0). The dreamer prompt asks for this, but LLMs don't
    // always comply, so we enforce it structurally.
    const scoreFloor = config.scoreFloor ?? 0.15;
    for (const n of nodes) {
        if (n.state === 'title') continue; // title nodes omit score, skip
        const s = n.score ?? scoreFloor;
        if (s < scoreFloor) {
            n.score = scoreFloor;
            stats.floored++;
        }
    }

    // Build a lookup of how many cycles each node has gone untouched.
    // We approximate "untouched cycles" via consecutive_decay from momentum,
    // which the dreamer already tracks. Nodes with high consecutive_decay
    // are candidates for resurface decay.
    const existingWildcardIds = new Set((map.wildcards || []).map(w => w.id));

    // --- Resurface Decay: inject stale nodes that haven't surfaced in a while ---
    const resurfaceThreshold = config.resurfaceThresholdCycles ?? 5;
    const resurfaceChance = config.resurfaceChance ?? 0.3;
    const staleCandidates = nodes.filter(n =>
        n.state !== 'title' &&
        !existingWildcardIds.has(n.id) &&
        (n.momentum?.consecutive_decay ?? 0) >= resurfaceThreshold
    );

    const resurfaced = [];
    for (const n of staleCandidates) {
        if (rng() < resurfaceChance) {
            resurfaced.push(n);
            existingWildcardIds.add(n.id);
            // Gradual nudge: bump resurfaced nodes up slightly so they're not
            // stuck at floor. Don't reset to baseline — just lift toward it.
            const current = n.score ?? scoreFloor;
            n.score = Math.min(0.35, current + 0.10);
        }
    }

    // --- Wildcard Boost: add random dormant/low-score nodes ---
    const boostCount = config.wildcardBoost ?? 3;
    // Pool is now "below baseline" rather than "below 0.5" — we want the
    // genuinely dormant nodes, not mid-tier ones.
    const pool = nodes.filter(n =>
        n.state !== 'title' &&
        !existingWildcardIds.has(n.id) &&
        (n.score ?? scoreFloor) < 0.35
    );

    // Fisher-Yates partial shuffle for random selection
    const boosted = [];
    for (let i = 0; i < boostCount && pool.length > 0; i++) {
        const idx = Math.floor(rng() * pool.length);
        const picked = pool.splice(idx, 1)[0];
        boosted.push(picked);
        existingWildcardIds.add(picked.id);
    }

    // Merge new wildcards into the map
    if (!map.wildcards) map.wildcards = [];
    for (const n of [...resurfaced, ...boosted]) {
        const isResurface = resurfaced.includes(n);
        map.wildcards.push({
            id: n.id,
            summary: n.summary || `(score ${n.score?.toFixed(2)})`,
            reason: isResurface ? 'resurface' : 'serendipity',
            tag: '✨'
        });
        stats.injected++;
        if (isResurface) stats.resurfaced++;
    }

    // --- Score Jitter: gentle stochastic breathing on non-extreme nodes ---
    // Applies to everything between floor and 0.8 — dormant, mid-tier, and
    // semi-important nodes all get slight variation. Only the top tier (0.8+)
    // is held stable, and title-only nodes are skipped (no score field).
    // This creates the "alive" feeling — scores drift slightly each cycle
    // rather than sitting frozen.
    const jitter = config.scoreJitter ?? 0.05;
    const jitterCeiling = config.jitterCeiling ?? 0.80;
    if (jitter > 0) {
        for (const n of nodes) {
            if (n.state === 'title') continue;
            const s = n.score ?? scoreFloor;
            if (s >= scoreFloor && s <= jitterCeiling) {
                const delta = (rng() - 0.5) * 2 * jitter; // ±jitter
                n.score = Math.max(scoreFloor, Math.min(jitterCeiling, s + delta));
                stats.jittered++;
            }
        }
    }

    // Tag the map so consumers know serendipity was applied
    map.meta.serendipity = {
        applied: true,
        seed: stats.seed,
        injected: stats.injected,
        resurfaced: stats.resurfaced,
        jittered: stats.jittered,
        floored: stats.floored
    };

    return stats;
}

// ─── Full Pipeline ───

async function runPipeline(force = false) {
    if (isRunning) {
        logger.info('[Dreaming] Pipeline already running, skipping', null, 'Dream');
        return { skipped: true, reason: 'already_running' };
    }

    // Check freshness (skip if < 30min old unless forced)
    const existingMap = loadJson(MAP_PATH, null);
    if (!force && existingMap?.meta?.generated_at) {
        const age = Date.now() - new Date(existingMap.meta.generated_at).getTime();
        if (age < 30 * 60 * 1000) {
            logger.info('[Dreaming] Map is fresh (< 30min), skipping', null, 'Dream');
            return { skipped: true, reason: 'fresh', age_minutes: Math.round(age / 60000) };
        }
    }

    isRunning = true;
    const startTime = Date.now();

    try {
        // Get memories from the memory agent.
        // New nDB-backed agent exposes .iter(); legacy JSON agent exposes .memories array.
        const allMemories = memoryAgent?.memories?.iter?.() || memoryAgent?.memories?.memories;
        if (!allMemories || allMemories.length === 0) {
            logger.info('[Dreaming] No memories to dream on', null, 'Dream');
            return { skipped: true, reason: 'no_memories' };
        }

        const contextBudget = agentConfig.contextBudget || 800000; // ~800K tokens

        // Determine "recent" = memories newer than last dream
        const lastDreamTime = existingMap?.meta?.generated_at;
        const recentMemories = lastDreamTime
            ? allMemories.filter(m => m.timestamp > lastDreamTime)
            : allMemories.slice(-50); // First run: last 50 as "recent"

        logger.info(`[Dreaming] Starting pipeline: ${allMemories.length} total, ${recentMemories.length} recent`, null, 'Dream');

        // Phase 1: Distillation
        const previousDistillate = loadJson(DISTILLATE_PATH, null);

        // If nothing has changed since the last distillation AND there are no
        // new memories since the last dream, the existing map is still current.
        // Skip the expensive dreamer call rather than regenerating an identical map.
        const snapshot = {};
        for (const m of allMemories) snapshot[m.id] = m.timestamp;
        const snapshotUnchanged = previousDistillate?.meta?.snapshot &&
            Object.keys(snapshot).length === Object.keys(previousDistillate.meta.snapshot).length &&
            Object.entries(snapshot).every(([id, ts]) => previousDistillate.meta.snapshot[id] === ts);

        if (recentMemories.length === 0 && snapshotUnchanged) {
            logger.info('[Dreaming] No new memories and no memory changes since last dream; skipping regeneration', null, 'Dream');
            return { skipped: true, reason: 'no_changes_since_last_dream' };
        }

        const { content: distillate, stats: distillateStats } = await distill(allMemories, previousDistillate, contextBudget);

        // Save distillate cache with snapshot of memory timestamps
        saveJson(DISTILLATE_PATH, {
            meta: {
                generated_at: new Date().toISOString(),
                total_memories: distillateStats.total_memories,
                distilled_chunks: distillateStats.distilled_chunks,
                snapshot
            },
            content: distillate
        });

        // Phase 2: Dreaming
        const map = await dream(distillate, recentMemories, existingMap, contextBudget);

        // Phase 2b: Serendipity Injection (stochastic wildcard boost + score jitter)
        const serendipityStats = applySerendipity(map, allMemories, existingMap, agentConfig.serendipity);
        if (serendipityStats.injected > 0 || serendipityStats.jittered > 0 || serendipityStats.floored > 0) {
            logger.info(`[Dreaming] Serendipity: ${serendipityStats.floored} floored, +${serendipityStats.injected} wildcards (${serendipityStats.resurfaced} resurfaced), ${serendipityStats.jittered} jittered`, null, 'Dream');
        }

        // Attach distillate stats
        map.meta.distillate_stats = distillateStats;

        // Coverage cutoff: timestamp of the dream run itself.
        // Memories created after this moment were not yet included in the map.
        // Using the dream run time (rather than the newest memory timestamp)
        // prevents the false impression that recent memories are unmapped when
        // the memory bank has simply not changed since the last dream.
        map.meta.coverage_cutoff = new Date().toISOString();

        // Ensure recall directive
        if (!map.recall_directive) {
            map.recall_directive = `Memories created or updated after ${map.meta.coverage_cutoff} are not reflected in this map. Use memory_recall for recent context.`;
        }

        // Phase 3: Save
        rotateBackup();
        saveJson(MAP_PATH, map);

        lastRunAt = new Date().toISOString();
        const duration = ((Date.now() - startTime) / 1000).toFixed(1);

        const summary = {
            generated: true,
            duration_seconds: parseFloat(duration),
            total_memories: allMemories.length,
            recent_memories: recentMemories.length,
            clusters: map.clusters?.length || 0,
            bridges: map.bridges?.length || 0,
            nodes: map.nodes?.length || 0,
            wildcards: map.wildcards?.length || 0,
            delta: map.meta?.delta || {},
            serendipity: serendipityStats,
            cache_hit_ratio: distillateStats.cache_hit_ratio,
            reflection: map.meta?.dreamer_reflection?.substring(0, 200)
        };

        logger.info(`[Dreaming] Pipeline complete in ${duration}s: ${summary.clusters} clusters, ${summary.bridges} bridges, ${summary.nodes} nodes`, null, 'Dream');
        return summary;

    } catch (err) {
        logger.error('[Dreaming] Pipeline failed', err, null, 'Dream');
        return { error: err.message };
    } finally {
        isRunning = false;
    }
}

// ─── Scheduler ───

function startScheduler(intervalMinutes) {
    if (scheduler) clearInterval(scheduler);
    const ms = (intervalMinutes || 60) * 60 * 1000;
    logger.info(`[Dreaming] Scheduler started: every ${intervalMinutes || 60} minutes`, null, 'Dream');
    scheduler = setInterval(() => {
        logger.info('[Dreaming] Scheduled run triggered', null, 'Dream');
        runPipeline(false);
    }, ms);
}

// ─── Agent Interface ───

export async function init(context) {
    gateway = context.gateway;
    prompts = context.prompts;
    agentConfig = context.config?.agents?.dreaming || {};
    memoryAgent = context.agents?.get('memory');

    if (!memoryAgent) {
        logger.warn('[Dreaming] Memory agent not available — dreaming disabled', null, 'Dream');
        return {};
    }

    const config = context.config?.agents?.dreaming || {};
    const autoStart = config.autoStart !== false; // default true

    if (autoStart) {
        // Always run on startup
        logger.info('[Dreaming] Running initial dream on startup', null, 'Dream');
        setTimeout(() => runPipeline(true), 10000);
        startScheduler(config.intervalMinutes || 60);
    }

    return {};
}

export async function shutdown() {
    if (scheduler) clearInterval(scheduler);
}

// ─── Tool Handlers ───

export async function dream_generate(args, context) {
    const { force = false } = args;
    const result = await runPipeline(force);

    if (result.skipped) {
        return { content: [{ type: 'text', text: `Dream skipped: ${result.reason}` }] };
    }
    if (result.error) {
        return { content: [{ type: 'text', text: `Dream failed: ${result.error}` }], isError: true };
    }

    const lines = [
        `✓ Dream complete in ${result.duration_seconds}s`,
        `  Memories: ${result.total_memories} total, ${result.recent_memories} recent`,
        `  Map: ${result.clusters} clusters, ${result.bridges} bridges, ${result.nodes} nodes, ${result.wildcards} wildcards`,
        `  Cache hit: ${(result.cache_hit_ratio * 100).toFixed(0)}%`,
    ];

    const delta = result.delta || {};
    const deltaParts = [];
    if (delta.promoted?.length) deltaParts.push(`${delta.promoted.length} promoted`);
    if (delta.demoted?.length) deltaParts.push(`${delta.demoted.length} demoted`);
    if (delta.compressed_to_summary?.length) deltaParts.push(`${delta.compressed_to_summary.length} → summary`);
    if (delta.compressed_to_title?.length) deltaParts.push(`${delta.compressed_to_title.length} → title`);
    if (deltaParts.length) lines.push(`  Delta: ${deltaParts.join(', ')}`);

    if (result.serendipity && (result.serendipity.injected > 0 || result.serendipity.jittered > 0 || result.serendipity.floored > 0)) {
        const parts = [];
        if (result.serendipity.floored > 0) parts.push(`${result.serendipity.floored} floored→0.15`);
        if (result.serendipity.injected > 0) parts.push(`+${result.serendipity.injected} wildcards (${result.serendipity.resurfaced} resurfaced)`);
        if (result.serendipity.jittered > 0) parts.push(`${result.serendipity.jittered} jittered`);
        lines.push(`  Serendipity: ${parts.join(', ')}${result.serendipity.seed !== null && result.serendipity.seed !== undefined ? ` [seed:${result.serendipity.seed}]` : ''}`);
    }

    if (result.reflection) lines.push(`  Reflection: ${result.reflection}`);

    return { content: [{ type: 'text', text: lines.join('\n') }] };
}

export async function dream_status(args, context) {
    const map = loadJson(MAP_PATH, null);
    const distillate = loadJson(DISTILLATE_PATH, null);
    const config = context.config?.agents?.dreaming || {};

    const lines = ['Dreaming System Status', ''];

    if (map) {
        const age = Date.now() - new Date(map.meta.generated_at).getTime();
        const ageMin = Math.round(age / 60000);
        lines.push(`Map: ${ageMin}min old (${map.nodes?.length || 0} nodes, ${map.clusters?.length || 0} clusters)`);
        lines.push(`Generated: ${map.meta.generated_at}`);
        lines.push(`Coverage cutoff: ${map.meta.coverage_cutoff || 'unknown'}`);
    } else {
        lines.push('Map: not yet generated');
    }

    if (distillate) {
        lines.push(`Distillate: cached (${distillate.meta?.total_memories || '?'} memories, ${distillate.meta?.distilled_chunks || '?'} chunks)`);
    } else {
        lines.push('Distillate: not yet cached');
    }

    lines.push(`Pipeline: ${isRunning ? 'RUNNING' : 'idle'}`);
    lines.push(`Last run: ${lastRunAt || 'never'}`);
    lines.push(`Interval: ${config.intervalMinutes || 60} minutes`);
    lines.push(`Context budget: ${(config.contextBudget || 800000).toLocaleString()} tokens`);

    const memCount = memoryAgent?.memories?.memories?.length || 0;
    lines.push(`Memory bank: ${memCount} memories`);

    return { content: [{ type: 'text', text: lines.join('\n') }] };
}

export async function dream_inject(args, context) {
    const { format = 'prompt' } = args;
    const map = loadJson(MAP_PATH, null);

    if (!map) {
        return { content: [{ type: 'text', text: 'No dream map available. Run dream_generate first.' }] };
    }

    if (format === 'json') {
        return { content: [{ type: 'text', text: JSON.stringify(map, null, 2) }] };
    }

    // Format for system prompt injection
    const lines = [
        `[MEMORY MAP v3.0 — generated ${map.meta.generated_at}]`,
        `Coverage cutoff: ${map.meta.coverage_cutoff}`,
        '',
    ];

    // Clusters summary
    if (map.clusters?.length) {
        lines.push('## Clusters');
        for (const c of map.clusters) {
            const hub = map.nodes?.find(n => n.id === c.hub_id);
            lines.push(`- ${c.name} (${c.id}): ${c.desc} [hub: #${c.hub_id}${hub ? ` score:${hub.score?.toFixed(2)}` : ''}]`);
        }
        lines.push('');
    }

    // Bridges
    if (map.bridges?.length) {
        lines.push('## Cross-Cluster Bridges');
        for (const b of map.bridges) {
            lines.push(`- #${b.from_id} ↔ #${b.to_id}: ${b.reason}`);
        }
        lines.push('');
    }

    // Nodes by cluster (compact)
    if (map.nodes?.length) {
        lines.push('## Nodes');
        const byCluster = {};
        const unclustered = [];
        for (const n of map.nodes) {
            if (n.cluster_id) {
                (byCluster[n.cluster_id] ??= []).push(n);
            } else {
                unclustered.push(n);
            }
        }
        for (const [cid, nodes] of Object.entries(byCluster)) {
            const cluster = map.clusters?.find(c => c.id === cid);
            lines.push(`[${cluster?.name || cid}]`);
            for (const n of nodes) {
                if (n.state === 'title') {
                    lines.push(`  #${n.id} [${n.category}] (title-only)`);
                } else if (n.state === 'summary') {
                    lines.push(`  #${n.id} [${n.category}] ${n.summary} (score:${n.score?.toFixed(2)})`);
                } else {
                    const bridge = n.is_bridge ? ' ★bridge' : '';
                    const type = n.type ? ` ${n.type}` : '';
                    lines.push(`  #${n.id}${type} [${n.category}] ${n.summary} (score:${n.score?.toFixed(2)}${bridge}) → [${(n.connections || []).join(',')}]`);
                }
            }
        }
        if (unclustered.length) {
            lines.push('[unclustered]');
            for (const n of unclustered) {
                lines.push(`  #${n.id} [${n.category}] ${n.summary || '(title-only)'}`);
            }
        }
        lines.push('');
    }

    // Wildcards
    if (map.wildcards?.length) {
        const hasSerendipity = map.wildcards.some(w => w.reason === 'serendipity' || w.reason === 'resurface');
        lines.push('## Wildcards (mental drift)');
        if (hasSerendipity) {
            lines.push('⚠ Some entries below (✨) were surfaced STOCHASTICALLY, not by importance score. Do NOT dismiss them on score alone — assess whether they connect to the current task. Random surfacing is deliberate.');
        }
        for (const w of map.wildcards) {
            const tag = w.tag || (w.reason === 'serendipity' || w.reason === 'resurface' ? '✨' : '');
            lines.push(`- ${tag} #${w.id}: ${w.summary} (${w.reason})`);
        }
        lines.push('');
    }

    // Reflection
    if (map.meta?.dreamer_reflection) {
        lines.push(`## Dreamer Reflection: ${map.meta.dreamer_reflection}`);
        lines.push('');
    }

    // Recall directive
    lines.push(map.recall_directive || `DIRECTIVE: Memories after ${map.meta.coverage_cutoff} are not in this map. Use memory_recall for recent context.`);

    return { content: [{ type: 'text', text: lines.join('\n') }] };
}
