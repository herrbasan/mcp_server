// Smoke test for issue #43: ctx.spawn PID registration + process-tree teardown.
// Spawns a real worker via worker-bootstrap with a tool that starts a long
// ping via ctx.spawn, asserts the 'spawned' message arrives with a live PID,
// then kills the tree like the orchestrator would (taskkill /T /F) and
// asserts the PID is gone. Exit 0 = pass.
import { Worker, MessageChannel } from 'worker_threads';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';

const execFileAsync = promisify(execFile);
const BOOTSTRAP = new URL('../src/agents/forge/worker-bootstrap.js', import.meta.url).pathname.replace(/^\//, '');

const pidAlive = async (pid) => {
    const { stdout } = await execFileAsync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']);
    return stdout.includes(`"${pid}"`);
};

const source = `
export default async function(args, ctx) {
    const child = ctx.spawn('ping', ['-n', '60', '127.0.0.1']);
    let out = '';
    child.stdout.on('data', d => { out += d; });
    await new Promise(res => { child.on('close', res); });
    return { lines: out.split('\\n').length };
}
`;

const tempFile = join(tmpdir(), `forge-smoke-src-${randomUUID()}.mjs`);
await writeFile(tempFile, source);

const { port1: gw1, port2: gw2 } = new MessageChannel();
const { port1: pr1, port2: pr2 } = new MessageChannel();
gw1.on('message', () => {}); gw1.start();
pr1.on('message', () => {}); pr1.start();

const worker = new Worker(BOOTSTRAP, {
    workerData: {
        source,
        args: {},
        workspacePath: tmpdir(),
        toolStatePath: tmpdir(),
        storagePath: tmpdir(),
        captureLogs: false
    }
});

let spawnedPid = null;
let result = null;
worker.postMessage({ type: 'init', gatewayPort: gw2, browserPort: null, mcpPort: null, mcpDepth: 0, progressPort: pr2, payload: [], defaultModel: null }, [gw2, pr2]);
const done = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('test timed out')), 30000);
    worker.on('message', (msg) => {
        if (msg.type === 'ready') {
            console.log('worker ready');
        } else if (msg.type === 'spawned') {
            spawnedPid = msg.pid;
            console.log(`spawned registered: pid=${msg.pid}`);
            // Simulate orchestrator teardown: kill tree, then terminate worker.
            (async () => {
                await new Promise(r => setTimeout(r, 1500));
                const aliveBefore = await pidAlive(spawnedPid);
                console.log(`child alive before kill: ${aliveBefore}`);
                if (!aliveBefore) throw new Error('child died before teardown — test invalid');
                await execFileAsync('taskkill', ['/PID', String(spawnedPid), '/T', '/F']);
                await new Promise(r => setTimeout(r, 1000));
                const aliveAfter = await pidAlive(spawnedPid);
                console.log(`child alive after kill: ${aliveAfter}`);
                clearTimeout(t);
                await worker.terminate();
                resolve(aliveAfter === false);
            })().catch(e => { clearTimeout(t); reject(e); });
        } else if (msg.type === 'result') {
            result = msg.result;
        } else if (msg.type === 'error') {
            console.log('worker error (expected — killed mid-run):', msg.error.slice(0, 100));
        }
    });
    worker.on('error', (e) => { clearTimeout(t); reject(e); });
});

const pass = await done;
await rm(tempFile, { force: true });
console.log(`RESULT: ${pass ? 'PASS — pid registered, tree kill verified' : 'FAIL'} (result: ${JSON.stringify(result)})`);
process.exit(pass ? 0 : 1);
