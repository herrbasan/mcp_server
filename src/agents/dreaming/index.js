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
function parseJsonLenient(text) {
    // Try raw parse first
    try { return JSON.parse(text); } catch (e) {
        logger.warn(`[Dreaming] Raw JSON parse failed: ${e.message}`, null, 'Dream');
    }

    // Save raw output for debugging
    const debugPath = join(DATA_DIR, 'dream_raw_output.json');
    writeFileSync(debugPath, text);
    logger.info(`[Dreaming] Saved raw output to ${debugPath} for inspection`, null, 'Dream');

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

async function dream(distillate, recentMemories, previousMap, contextBudget) {
    const dreamerPrompt = prompts.dreamer;
    if (!dreamerPrompt) throw new Error('Dreamer prompt not loaded');

    // Build the input: distillate + full recent memories + previous map context
    let input = '';

    // Distilled history
    if (distillate) {
        input += '=== DISTILLED HISTORY ===\n';
        input += distillate;
        input += '\n\n';
    }

    // Full recent memories (no compression)
    if (recentMemories.length > 0) {
        input += '=== FULL RECENT MEMORIES (since last dream) ===\n';
        for (const m of recentMemories) {
            input += formatMemory(m) + '\n\n';
        }
    }

    // Previous map for momentum
    if (previousMap?.nodes) {
        input += '=== PREVIOUS MAP (for connection momentum) ===\n';
        input += 'Node connections from previous dream:\n';
        for (const node of previousMap.nodes) {
            if (node.connections?.length > 0) {
                input += `#${node.id}: connections=[${node.connections.join(',')}] momentum=${JSON.stringify(node.momentum || { delta: 0, consecutive_decay: 0 })}\n`;
            }
        }
        input += '\n';
    }

    // Check if input fits budget
    const promptTokens = tokenEstimate(dreamerPrompt);
    const inputTokens = tokenEstimate(input);
    const totalNeeded = promptTokens + inputTokens + 4000; // output reserve

    if (totalNeeded > contextBudget) {
        logger.warn(`[Dreaming] Input (${inputTokens} tokens) + prompt (${promptTokens}) exceeds budget (${contextBudget}). Truncating distillate.`, null, 'Dream');
        const maxInputTokens = contextBudget - promptTokens - 4000;
        const distillateBudget = maxInputTokens - tokenEstimate(
            '=== FULL RECENT MEMORIES ===\n' +
            recentMemories.map(formatMemory).join('\n\n') +
            '\n=== PREVIOUS MAP ===\n'
        );
        if (distillateBudget > 0) {
            const maxChars = distillateBudget * 4;
            input = input.replace(distillate, distillate.slice(0, maxChars));
        }
    }

    logger.info(`[Dreaming] Running dreamer (${inputTokens} tokens input, ${promptTokens} prompt)`, null, 'Dream');

    const response = await gateway.chat({
        task: agentConfig.dreamerTask || 'query',
        messages: [{ role: 'user', content: dreamerPrompt + input }],
        systemPrompt: 'You are a memory topology agent. Output ONLY valid JSON. No markdown. No code blocks.',
        maxTokens: 64000,
        temperature: 0.3,
        enableThinking: false
    });

    // Parse the JSON response with repair
    let mapText = response.content || '';
    const firstBrace = mapText.indexOf('{');
    const lastBrace = mapText.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        mapText = mapText.substring(firstBrace, lastBrace + 1);
    }

    const map = parseJsonLenient(mapText);

    // Validate minimum structure
    if (!map.meta || !map.nodes || !Array.isArray(map.nodes)) {
        throw new Error('Dreamer output missing required fields (meta, nodes)');
    }

    // Ensure version tag and override LLM-generated timestamps with actual wall-clock time
    map.meta.version = '3.0';
    map.meta.generated_at = new Date().toISOString();

    return map;
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
        // Get memories from the memory agent
        const allMemories = memoryAgent?.memories?.memories;
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
        const { content: distillate, stats: distillateStats } = await distill(allMemories, previousDistillate, contextBudget);

        // Save distillate cache with snapshot of memory timestamps
        const snapshot = {};
        for (const m of allMemories) snapshot[m.id] = m.timestamp;
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

        // Coverage cutoff: newest memory timestamp that the map actually reflects.
        // This tells consumers which memories are newer than the map (and need live recall).
        const newestMemoryTs = allMemories.length > 0
            ? allMemories.reduce((a, b) => a.timestamp > b.timestamp ? a : b).timestamp
            : new Date().toISOString();
        map.meta.coverage_cutoff = newestMemoryTs;

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
