#!/usr/bin/env node
/**
 * Re-embed all memories with new embedding model
 * Usage: node scripts/reembed-memories.js
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load config
const config = JSON.parse(readFileSync(join(__dirname, '..', 'config.json'), 'utf-8'));
const gatewayHttpUrl = config.gateway.httpUrl;

const memoriesPath = join(__dirname, '..', 'data', 'memories.json');

async function embedText(text) {
    const res = await fetch(`${gatewayHttpUrl}/v1/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: text, task: 'embed' })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return data.data[0].embedding;
}

async function main() {
    console.log('🔧 Memory Re-embedding Tool');
    console.log(`Gateway: ${gatewayHttpUrl}`);
    console.log('Using task: embed (Gateway-managed model)');
    console.log('');

    // Load memories
    let memories;
    try {
        memories = JSON.parse(readFileSync(memoriesPath, 'utf-8'));
    } catch (err) {
        console.error('Failed to load memories:', err.message);
        process.exit(1);
    }

    if (!memories.memories || memories.memories.length === 0) {
        console.log('No memories found.');
        process.exit(0);
    }

    const total = memories.memories.length;
    const oldDim = memories.memories[0].embedding?.length || 'none';
    
    console.log(`Found ${total} memories to re-embed`);
    console.log(`Current embedding dimension: ${oldDim}`);
    console.log('');

    // Confirm
    if (process.argv.includes('--yes')) {
        console.log('Proceeding (auto-confirmed with --yes)...');
    } else {
        console.log('⚠️  This will regenerate ALL embeddings. Old embeddings will be lost.');
        console.log('   Run with --yes to skip this confirmation.');
        console.log('   Press Ctrl+C to cancel, or wait 3 seconds to proceed...');
        await new Promise(r => setTimeout(r, 3000));
    }

    // Create backup
    const backupPath = memoriesPath + '.backup.' + Date.now();
    writeFileSync(backupPath, JSON.stringify(memories, null, 2));
    console.log(`\n📦 Backup created: ${backupPath}`);
    console.log('');

    // Re-embed each memory
    let success = 0;
    let failed = 0;
    const startTime = Date.now();

    for (let i = 0; i < memories.memories.length; i++) {
        const memory = memories.memories[i];
        const num = i + 1;
        
        process.stdout.write(`[${num}/${total}] Re-embedding #${memory.id}... `);
        
    try {
            const text = memory.chunkInfo 
                ? memory.text  // Use chunk text directly
                : memory.text;
            
            const newEmbedding = await embedText(text);
            memory.embedding = newEmbedding;
            success++;
            process.stdout.write(`✓ (${newEmbedding.length}d)\n`);
        } catch (err) {
            failed++;
            process.stdout.write(`✗ ERROR: ${err.message}\n`);
        }
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log('');
    console.log(`✅ Done in ${duration}s`);
    console.log(`   Success: ${success}/${total}`);
    console.log(`   Failed:  ${failed}/${total}`);

    if (success > 0) {
        // Save updated memories
        writeFileSync(memoriesPath, JSON.stringify(memories, null, 2));
        console.log(`\n💾 Saved to: ${memoriesPath}`);
        
        // Show new dimension
        const newDim = memories.memories.find(m => m.embedding)?.embedding?.length;
        if (newDim) {
            console.log(`   New embedding dimension: ${newDim}`);
        }
    }

    process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
