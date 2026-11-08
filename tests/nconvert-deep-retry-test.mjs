// Contract after P0 (2026-11-07): the coverage guard is a diagnostic, not a
// gate. A chunk that measures low — including one whose corrective retry then
// dies — ships as the model read it, with the measured gap recorded, and the
// mechanical text stays beside it in document.mechanical.md.
// Live evidence that forced the change (DKV scan, 2026-11-07): attempt 1 read
// the page at 74.4%, the retry lost both providers, and the artefact shipped
// mechanical OCR-layer text labelled `coverage: 100.0%` — a page the model had
// already read was thrown away and the report said nothing was missing.

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
                // Production configures no fallback (one target, 2026-11-08). The
                // rotation mechanism still has to work for anyone who does, so
                // this test declares a two-model chain explicitly.
                visionModel: 'badkid-llama-chat',
                visionFallbackModels: ['deepseek-flash-chat'],
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
        const documentMd = fs.readFileSync(path.join(folder, 'document.md'), 'utf8');

        check('a failed retry keeps the measured attempt', meta.deep?.chunks?.[0]?.verdict === 'kept-low-coverage', JSON.stringify(meta.deep?.chunks));
        check('retry failure is reported, not masked as a vision failure', codes.includes('deep-retry-failed') && !codes.includes('deep-chunk-failed'), JSON.stringify(codes));
        check('the kept attempt still reports its low coverage', codes.includes('deep-low-coverage'), JSON.stringify(codes));
        check('the shipped chunk is the model reading, not the mechanical text', documentMd.includes('A fragment that keeps nothing.'), documentMd.split('\n').slice(0, 14).join(' | '));
        check('no chunk is refused into a rejected layer any more', meta.deep?.rejected === undefined && meta.deep.chunks.every((c) => !c.rejected), JSON.stringify(meta.deep?.chunks));
        check('measured coverage is reported, never a fabricated 100%', typeof meta.deep?.meanCoverage === 'number' && meta.deep.meanCoverage >= 0 && meta.deep.meanCoverage < 0.5, String(meta.deep?.meanCoverage));
        check('frontmatter states the measured coverage', /^coverage: \d+\.\d%$/m.test(documentMd) && !/^coverage: 100\.0%$/m.test(documentMd), documentMd.split('\n').slice(0, 14).join(' | '));
        check('frontmatter counts the kept chunk as structured', /^chunks: 1\/1 structured$/m.test(documentMd), documentMd.split('\n').slice(0, 14).join(' | '));
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
