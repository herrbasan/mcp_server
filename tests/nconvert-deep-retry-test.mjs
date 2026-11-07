// Regression: a corrective retry that dies must not erase the attempt that
// already measured, and an unmeasured deep run must never report 100% coverage.
// Live evidence (2026-11-07, DKV scan): attempt 1 read the page at 74.4%,
// the retry lost both providers, and the artefact shipped mechanical OCR-layer
// text labelled `coverage: 100.0%` with a `deep-chunk-failed` warning.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const pdf = 'H:/Ingest_TestFiles/GSB_11_Anwendungshandbuch_11.2.4.pdf';
if (!fs.existsSync(pdf)) {
    console.log('  skip deep retry test (test corpus absent)');
    process.exit(0);
}

const agent = await import('../src/agents/nconvert/index.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nconvert-deep-retry-'));
const visionModels = [];
let visionCalls = 0;

await agent.init({
    gateway: {
        async chat({ model }) {
            visionModels.push(model);
            visionCalls++;
            if (visionCalls === 1) return { content: 'A fragment that keeps nothing.' };
            return { content: '' };
        }
    },
    config: {
        agents: {
            storage: { root: tmp },
            nconvert: {
                nativeProcesses: 2,
                maxDeepPages: 2,
                chunkPages: 2,
                coverageThreshold: 0.98,
                coverageRetry: true,
                verify: false,
                summary: false
            }
        }
    }
});

let failures = 0;
function check(name, condition, detail = '') {
    if (condition) console.log(`  ok   ${name}`);
    else { failures++; console.error(`  FAIL ${name} ${detail}`); }
}

try {
    await agent.nconvert_convert({ path: pdf, depth: 'deep', keepOriginal: false });
    const job = agent.getQueue().jobs.at(-1);
    const deadline = Date.now() + 60000;
    while (!['done', 'failed', 'cancelled'].includes(job.state) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    check('deep job completes', job.state === 'done', `${job.state}: ${job.error || ''}`);

    if (job.state === 'done') {
        const folder = path.join(tmp, job.result.item);
        const meta = JSON.parse(fs.readFileSync(path.join(folder, 'meta.json'), 'utf8'));
        const codes = (meta.warnings || []).map((w) => w.code);

        check('retry failure keeps the measured attempt', meta.deep?.chunks?.[0]?.verdict === 'fallback-low-coverage', JSON.stringify(meta.deep?.chunks));
        check('retry failure is reported, not masked as a vision failure', codes.includes('deep-retry-failed') && !codes.includes('deep-chunk-failed'), JSON.stringify(codes));
        check('kept attempt still reports its low coverage', codes.includes('deep-low-coverage'), JSON.stringify(codes));
        check('unmeasured coverage is null, never 100%', meta.deep?.meanCoverage === null, String(meta.deep?.meanCoverage));

        const documentMd = fs.readFileSync(path.join(folder, 'document.md'), 'utf8');
        check('frontmatter states coverage n/a', /^coverage: n\/a$/m.test(documentMd), documentMd.split('\n').slice(0, 14).join(' | '));
        check('frontmatter states how many chunks structured', /^chunks: 0\/1 structured$/m.test(documentMd));
        const caps = JSON.parse((await agent.nconvert_capabilities()).content[0].text);
        const chain = [caps.deep.visionModel, ...caps.deep.visionFallbackModels];
        check('the retry rotates and walks the whole chain', JSON.stringify(visionModels) === JSON.stringify([chain[0], ...chain.slice(1), chain[0]]), `${JSON.stringify(visionModels)} vs ${JSON.stringify(chain)}`);
    }
} finally {
    await agent.shutdown();
    fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
