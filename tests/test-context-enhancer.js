// Standalone test harness for the VDB context enhancer.
//
// Usage:
//   node tests/test-context-enhancer.js <path-or-glob> [options]
//
// Examples:
//   node tests/test-context-enhancer.js D:\MCP_Storage\digital-twin\herrbasan-digital-twin.md
//   node tests/test-context-enhancer.js D:\MCP_Storage\blog --recursive --limit 5
//   node tests/test-context-enhancer.js D:\DEV\mcp_server\docs\vdb-agent-spec.md --task local --maxInputChars 8000
//
// Options:
//   --task <name>        Gateway task to use (default: local)
//   --maxInputChars <n>  Truncate file content to this many chars (default: 12000)
//   --maxOutputTokens <n> Max tokens for metadata generation (default: 512)
//   --temperature <n>    Sampling temperature (default: 0.3)
//   --truncation <mode>  head | headtail | middle (default: head)
//   --prompt <file>      Path to a custom prompt template file
//   --recursive          Scan directories recursively
//   --limit <n>          Stop after n files
//   --json               Output raw JSON instead of formatted text
//   --no-header          Do not print the generated context header

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { createGatewayClient } from '../src/gateway-client.js';
import { makeChunker } from '../src/agents/vdb/chunker.js';
import { createContextEnhancer } from '../src/agents/vdb/context-enhancer.js';
import { getLogger } from '../src/utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// Load mcp_server config.json for gateway URL
const configPath = path.resolve(__dirname, '..', 'config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

const logger = getLogger();

function parseArgs(argv) {
    const args = {
        target: null,
        task: 'local',
        maxInputChars: 12000,
        maxOutputTokens: 512,
        temperature: 0.3,
        promptFile: null,
        recursive: false,
        limit: Infinity,
        truncation: 'headmidtail',
        json: false,
        header: true
    };

    for (let i = 2; i < argv.length; i++) {
        const arg = argv[i];
        if (arg.startsWith('--')) {
            const key = arg.slice(2);
            if (key === 'recursive') { args.recursive = true; continue; }
            if (key === 'json') { args.json = true; continue; }
            if (key === 'no-header') { args.header = false; continue; }
            const value = argv[++i];
            if (value === undefined) throw new Error(`Missing value for ${arg}`);
            if (key === 'task') args.task = value;
            else if (key === 'maxInputChars') args.maxInputChars = Number(value);
            else if (key === 'maxOutputTokens') args.maxOutputTokens = Number(value);
            else if (key === 'temperature') args.temperature = Number(value);
            else if (key === 'prompt') args.promptFile = value;
            else if (key === 'limit') args.limit = Number(value);
            else if (key === 'truncation') args.truncation = value;
            else throw new Error(`Unknown option: ${arg}`);
        } else {
            if (args.target) throw new Error('Only one target path allowed');
            args.target = arg;
        }
    }

    if (!args.target) throw new Error('Target path required');
    return args;
}

function collectFiles(target, recursive) {
    const stat = fs.statSync(target);
    if (stat.isFile()) return [target];
    if (!stat.isDirectory()) throw new Error(`Not a file or directory: ${target}`);

    const files = [];
    function walk(dir) {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory() && recursive) {
                walk(full);
            } else if (entry.isFile()) {
                files.push(full);
            }
        }
    }
    walk(target);
    return files;
}

function isTextFile(filePath) {
    const textExts = ['.md', '.txt', '.json', '.js', '.mjs', '.css', '.html', '.htm', '.log', '.yaml', '.yml', '.xml', '.csv', '.tsv', '.sql'];
    return textExts.includes(path.extname(filePath).toLowerCase());
}



async function main() {
    const args = parseArgs(process.argv);
    const files = collectFiles(args.target, args.recursive).filter(isTextFile).slice(0, args.limit);

    if (files.length === 0) {
        console.error('No text files found.');
        process.exit(1);
    }

    const gateway = createGatewayClient(config.gateway.wsUrl, config.gateway.httpUrl);

    // Wait for WebSocket connection
    let waited = 0;
    while (!gateway.connected && waited < 10000) {
        await new Promise(r => setTimeout(r, 100));
        waited += 100;
    }
    if (!gateway.connected) {
        console.error('Gateway not connected after 10s');
        process.exit(1);
    }

    const enhancerConfig = {
        enabled: true,
        task: args.task,
        maxInputChars: args.maxInputChars,
        maxOutputTokens: args.maxOutputTokens,
        temperature: args.temperature,
        truncation: args.truncation,
        prompt: args.promptFile ? fs.readFileSync(args.promptFile, 'utf-8') : undefined
    };

    const enhancer = createContextEnhancer(enhancerConfig, gateway, logger);
    const chunker = makeChunker({ maxTokens: 1024, overlapTokens: 128, tokCharsRatio: 2.5 });

    const results = [];
    let totalMs = 0;
    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const rel = path.relative(args.target, file);
        const content = fs.readFileSync(file, 'utf-8');
        const chunks = chunker(content);

        const prepared = {
            absolutePath: file,
            relPath: rel,
            tokCharsRatio: 2.5,
            metadata: {},
            chunks: chunks.map((c, idx) => ({
                docId: `${rel}#${idx}`,
                text: c.text,
                splitIdx: c.splitIdx,
                charOffset: c.charOffset,
                isLastChunk: c.isLastChunk,
                tokEst: c.tokEst
            }))
        };

        const start = Date.now();
        const enhanced = await enhancer.enhance(prepared);
        const elapsed = Date.now() - start;
        totalMs += elapsed;

        const ok = enhanced.metadata.contextEnhanced === true;
        if (ok) successCount++;
        else failCount++;

        const result = {
            file: rel,
            size: content.length,
            chunks: chunks.length,
            elapsedMs: elapsed,
            ok,
            error: enhanced.metadata.contextError || null,
            metadata: {
                docType: enhanced.metadata.docType,
                summary: enhanced.metadata.summary,
                keywords: enhanced.metadata.keywords,
                entities: enhanced.metadata.entities
            },
            header: args.header && enhanced.chunks[0]?.text ? enhanced.chunks[0].text.split('\n\n')[0] : null
        };

        results.push(result);

        if (!args.json) {
            console.log(`\n--- ${i + 1}/${files.length} ${rel} ---`);
            console.log(`size=${content.length} chars, chunks=${chunks.length}, elapsed=${elapsed}ms, ok=${ok}`);
            if (ok) {
                console.log(`Type: ${result.metadata.docType}`);
                console.log(`Summary: ${result.metadata.summary}`);
                console.log(`Keywords: ${result.metadata.keywords?.join(', ')}`);
                console.log(`Entities: ${result.metadata.entities?.join(', ')}`);
                if (args.header && result.header) console.log(`Header preview:\n${result.header}`);
            } else {
                console.log(`Error: ${result.error}`);
            }
        }
    }

    const summary = {
        filesTested: files.length,
        success: successCount,
        failed: failCount,
        totalMs,
        avgMs: files.length ? Math.round(totalMs / files.length) : 0,
        task: args.task,
        maxInputChars: args.maxInputChars,
        maxOutputTokens: args.maxOutputTokens,
        temperature: args.temperature,
        truncation: args.truncation
    };

    if (args.json) {
        console.log(JSON.stringify({ summary, results }, null, 2));
    } else {
        console.log(`\n=== Summary ===`);
        console.log(`Files: ${files.length}, Success: ${successCount}, Failed: ${failCount}`);
        console.log(`Total time: ${totalMs}ms, Avg per file: ${summary.avgMs}ms`);
    }

    gateway.close();
    process.exit(0);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
