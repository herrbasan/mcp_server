// ============================================
// fileops benchmark — copy 100MB, grep 50MB, batch vs individual writes
// ============================================

import fs from 'fs';
import path from 'path';
import os from 'os';
import { createFileOps } from '../src/lib/fileops.js';

function fmt(ms) {
    if (ms < 1000) return `${ms.toFixed(1)}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
}

function mb(bytes) {
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fileops-bench-'));
const ops = createFileOps({ root });

console.log('=== fileops benchmark ===\n');

// ============================================
// 1. Copy 100MB file
// ============================================

{
    const srcPath = path.join(root, 'big-100mb.bin');
    const size = 100 * 1024 * 1024;
    // Write 100MB of pseudo-random data (deterministic seed)
    const chunkSize = 1024 * 1024;
    const chunk = Buffer.alloc(chunkSize);
    for (let i = 0; i < chunkSize; i++) chunk[i] = (i * 7 + 13) & 0xff;
    const fd = fs.openSync(srcPath, 'w');
    for (let i = 0; i < 100; i++) fs.writeSync(fd, chunk);
    fs.closeSync(fd);

    console.log(`[1] Copy ${mb(size)} file`);
    const start = performance.now();
    await ops.copy('big-100mb.bin', 'big-100mb-copy.bin');
    const elapsed = performance.now() - start;
    const dst = await ops.stat('big-100mb-copy.bin');
    console.log(`    copy: ${fmt(elapsed)} (${mb(dst.size)} written)\n`);

    fs.unlinkSync(srcPath);
    fs.unlinkSync(path.join(root, 'big-100mb-copy.bin'));
}

// ============================================
// 2. Grep 50MB file
// ============================================

{
    const lines = [];
    const targetLineCount = 610000; // ~50MB at ~82 bytes/line
    for (let i = 0; i < targetLineCount; i++) {
        if (i % 10000 === 0) {
            lines.push(`line ${i} NEEDLE found here with some padding text to make it longer`);
        } else {
            lines.push(`line ${i} just some filler content that is reasonably long to pad the file size out`);
        }
    }
    const content = lines.join('\n');
    await ops.write('grep-50mb.txt', content);
    const st = await ops.stat('grep-50mb.txt');

    console.log(`[2] Grep ${mb(st.size)} file (${targetLineCount} lines)`);
    const start = performance.now();
    const result = await ops.grep('grep-50mb.txt', 'NEEDLE');
    const elapsed = performance.now() - start;
    console.log(`    grep: ${fmt(elapsed)} (${result.matches.length} matches)\n`);

    fs.unlinkSync(path.join(root, 'grep-50mb.txt'));
}

// ============================================
// 3. Batch 1000 writes vs 1000 individual writes
// ============================================

const N = 1000;

// Individual writes
{
    console.log(`[3a] ${N} individual write() calls`);
    const start = performance.now();
    for (let i = 0; i < N; i++) {
        await ops.write(`indiv/file-${i}.txt`, `content ${i}`);
    }
    const elapsed = performance.now() - start;
    console.log(`    individual: ${fmt(elapsed)} (${(N / (elapsed / 1000)).toFixed(0)} ops/sec)\n`);
}

// Batch writes
{
    const batchList = Array.from({ length: N }, (_, i) => ({
        op: 'write',
        path: `batch/file-${i}.txt`,
        content: `content ${i}`
    }));

    console.log(`[3b] ${N} writes in a single batch() call`);
    const start = performance.now();
    const result = await ops.batch(batchList);
    const elapsed = performance.now() - start;
    const okCount = result.results.filter(r => r.ok).length;
    console.log(`    batch: ${fmt(elapsed)} (${okCount} ok, ${(N / (elapsed / 1000)).toFixed(0)} ops/sec)\n`);
}

// Cleanup
fs.rmSync(root, { recursive: true, force: true });
console.log('=== benchmark complete ===');
