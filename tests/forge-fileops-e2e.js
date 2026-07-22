// Quick E2E harness: spawn forge worker-bootstrap with a tool that uses ctx.fileops.
// Verifies the whole chain: workerData → bootstrap → createFileOps → confined write
// with versioning inside the tool storage dir.
import { Worker } from 'worker_threads';
import { MessageChannel } from 'worker_threads';
import fs from 'fs';
import path from 'path';
import os from 'os';

const BOOTSTRAP = path.resolve('src/agents/forge/worker-bootstrap.js');

const toolStorage = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-fileops-e2e-'));

const source = `
export default async function(args, ctx) {
    if (!ctx.fileops) throw new Error('ctx.fileops is MISSING');
    // write → overwrite (version) → replace (version) → history → restore
    await ctx.fileops.write('out.txt', 'hello MARKER world');
    await ctx.fileops.write('out.txt', 'hello MARKER world v2', { overwrite: true });
    const r = await ctx.fileops.replace('out.txt', 'MARKER', 'REPLACED');
    const hist = await ctx.fileops.history('out.txt');
    await ctx.fileops.restore('out.txt');
    const back = await ctx.fileops.read('out.txt');
    // confinement check
    let escapeThrew = false;
    try { await ctx.fileops.write('../escape.txt', 'x'); } catch (e) { escapeThrew = /escapes root/.test(e.message); }
    return {
        replacements: r.replacements,
        versions: hist.versions.length,
        restored: back.content,
        escapeThrew
    };
}
`;

const worker = new Worker(BOOTSTRAP, {
    workerData: {
        source,
        args: {},
        workspacePath: toolStorage,
        toolStatePath: toolStorage,
        storagePath: toolStorage,
        uncShare: null,
        localRoot: null,
        captureLogs: true
    }
});

const { port1: gw1, port2: gw2 } = new MessageChannel();
const { port1: pg1, port2: pg2 } = new MessageChannel();
gw1.on('message', () => {});
pg1.on('message', () => {});
gw1.start(); pg1.start();

worker.postMessage({ type: 'init', gatewayPort: gw2, progressPort: pg2, payload: [], defaultModel: null }, [gw2, pg2]);

const result = await new Promise((resolve, reject) => {
    worker.on('message', (msg) => {
        if (msg.type === 'result') resolve(msg.result);
        if (msg.type === 'error') reject(new Error(msg.error + '\n' + (msg.stack || '')));
    });
    worker.on('error', reject);
    setTimeout(() => reject(new Error('TIMEOUT')), 30000);
});

console.log('RESULT:', JSON.stringify(result, null, 2));

const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); process.exit(1); } };
assert(result.replacements === 1, 'replacements should be 1');
assert(result.versions >= 2, 'should have >=2 versions, got ' + result.versions);
assert(result.restored === 'hello MARKER world v2', 'restore should step back one version, got: ' + result.restored);
assert(result.escapeThrew === true, 'confinement escape should throw');

console.log('ALL ASSERTIONS PASS — ctx.fileops is live in forge workers');
worker.terminate();
fs.rmSync(toolStorage, { recursive: true, force: true });
process.exit(0);
