// Diagnostic 3 — reproduces the REAL production failure (#27, #31):
// main thread blocked by sync work LONGER than the idle window while the
// tool emits steady progress. With a setTimeout idle, the expired timer
// (timers phase) kills the worker before its queued progress messages are
// delivered (poll phase). With the setImmediate check loop, queued activity
// is accounted first and the tool SURVIVES.
//
// Expected: block 10s, idle 3s, progress every 2s, tool total ~8s.
//   OLD impl: killed  → exit 1
//   NEW impl: survives → result totalMs ≈ 8000, exit 0

import { Worker, MessageChannel } from 'worker_threads';
import path from 'path';

const BOOTSTRAP = path.resolve('src/agents/forge/worker-bootstrap.js');

const toolSource = `
export default async function(args, ctx) {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const t0 = Date.now();
    for (let i = 1; i <= 4; i++) {
        ctx.progress('cycle ' + i, i, 4);
        await sleep(2000);
    }
    return { totalMs: Date.now() - t0 };
}
`;

const { port1: progressPort1, port2: progressPort2 } = new MessageChannel();
const { port1: gatewayPort1, port2: gatewayPort2 } = new MessageChannel();

let settled = false;
let ready = false;
let idleCheckScheduled = false;
let lastActivityAt = 0;
const IDLE = 3000;
const spawnT = Date.now();
const t = () => `+${((Date.now() - spawnT) / 1000).toFixed(2)}s`;

// ── NEW-IMPL idle check (setImmediate loop) — mirrors forge/index.js ──
const idleCheck = () => {
    if (settled || !ready) return;
    const silentFor = Date.now() - lastActivityAt;
    if (silentFor >= IDLE) {
        console.log(`[${t()}] *** IDLE FIRED after ${silentFor}ms silence ***`);
        console.log('VERDICT: FAILED — healthy tool killed under main-thread block');
        worker.terminate().then(() => process.exit(1));
        return;
    }
    setImmediate(idleCheck);
};
const armOnReady = () => {
    if (ready) return;
    ready = true;
    lastActivityAt = Date.now();
    if (!idleCheckScheduled) {
        idleCheckScheduled = true;
        setImmediate(idleCheck);
    }
};
const activity = () => { if (ready) lastActivityAt = Date.now(); };

progressPort1.on('message', (msg) => {
    console.log(`[${t()}] progress delivered (type=${msg.type})`);
    activity();
});
progressPort1.start();

const worker = new Worker(BOOTSTRAP, {
    workerData: {
        source: toolSource,
        args: {},
        workspacePath: process.cwd(),
        toolStatePath: process.cwd(),
        storagePath: process.cwd(),
        captureLogs: false
    },
    resourceLimits: { maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 128 }
});

worker.on('message', (msg) => {
    if (msg.type === 'ready') {
        console.log(`[${t()}] ready received → idle check armed`);
        armOnReady();
        // ── Simulate #31: block the main thread 10s, longer than IDLE=3s.
        // The tool posts progress at +2s/+4s/+6s — all queue during this.
        console.log(`[${t()}] === BLOCKING MAIN THREAD FOR 10s (simulating VDB scan) ===`);
        const stop = Date.now() + 10000;
        while (Date.now() < stop) { /* sync block */ }
        console.log(`[${t()}] === UNBLOCKED — queued messages now deliver ===`);
        return;
    }
    activity();
    if (msg.type === 'result') {
        console.log(`[${t()}] *** RESULT: ${JSON.stringify(msg.result)}`);
        console.log('VERDICT: PASSED — tool survived main-thread block, idle semantics intact');
        settled = true;
        worker.terminate().then(() => process.exit(0));
    } else if (msg.type === 'error') {
        console.log(`[${t()}] *** ERROR: ${msg.error}`);
        settled = true;
        worker.terminate().then(() => process.exit(1));
    }
});
worker.on('error', (err) => console.log(`[${t()}] worker ERROR event:`, err.message));
worker.on('exit', (code) => {
    console.log(`[${t()}] worker EXIT code=${code} settled=${settled}`);
    if (!settled) {
        console.log('VERDICT: FAILED — worker died unsettled');
        process.exit(1);
    }
});

worker.postMessage({
    type: 'init',
    gatewayPort: gatewayPort2,
    browserPort: null,
    mcpPort: null,
    mcpDepth: 0,
    progressPort: progressPort2,
    payload: [],
    defaultModel: null
}, [gatewayPort2, progressPort2]);
console.log(`[${t()}] init posted`);

setTimeout(() => {
    console.log(`[${t()}] *** GLOBAL 25s TIMEOUT ***`);
    worker.terminate().then(() => process.exit(3));
}, 25000);
