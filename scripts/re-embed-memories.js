import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MEMORIES_PATH = join(__dirname, '..', 'data', 'memories.json');
const GATEWAY_HTTP = process.env.GATEWAY_HTTP_URL || 'http://localhost:3400';
const BATCH_SIZE = 10;
const MAX_CHARS = 6000;

async function embedBatch(texts) {
    const res = await fetch(`${GATEWAY_HTTP}/v1/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: texts, task: 'embed' })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return data.data.map(d => d.embedding);
}

function buildText(memory) {
    const parts = [memory.description];
    if (memory.data) parts.push(memory.data);
    const combined = parts.join(' ');
    return combined.length > MAX_CHARS ? combined.slice(0, MAX_CHARS) : combined;
}

async function reembed() {
    const store = JSON.parse(readFileSync(MEMORIES_PATH, 'utf-8'));
    const { memories } = store;
    console.log(`Re-embedding ${memories.length} memories...`);

    const oldDim = memories[0]?.embedding?.length || 0;
    console.log(`Old embedding dimension: ${oldDim}`);

    let newDim = 0;
    let processed = 0;

    for (let i = 0; i < memories.length; i += BATCH_SIZE) {
        const batch = memories.slice(i, i + BATCH_SIZE);
        const texts = batch.map(buildText);

        let retries = 3;
        let embeddings;
        while (retries > 0) {
            try {
                embeddings = await embedBatch(texts);
                break;
            } catch (err) {
                retries--;
                if (retries === 0) throw err;
                console.log(`  Batch ${i / BATCH_SIZE + 1} failed (${err.message}), retrying... (${retries} left)`);
                await new Promise(r => setTimeout(r, 2000));
            }
        }

        for (let j = 0; j < batch.length; j++) {
            batch[j].embedding = embeddings[j];
        }

        if (!newDim && embeddings[0]) {
            newDim = embeddings[0].length;
            console.log(`New embedding dimension: ${newDim}`);
        }

        processed += batch.length;
        process.stdout.write(`\r  ${processed}/${memories.length} (${((processed / memories.length) * 100).toFixed(0)}%)`);

        if (i + BATCH_SIZE < memories.length) {
            await new Promise(r => setTimeout(r, 100));
        }
    }

    console.log(`\nSaving ${memories.length} memories with ${newDim}-dim embeddings...`);
    writeFileSync(MEMORIES_PATH, JSON.stringify(store, null, 2));
    console.log('Done.');
}

reembed().catch(err => {
    console.error('Fatal:', err.message);
    process.exit(1);
});
