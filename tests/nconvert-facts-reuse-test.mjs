// Three guarantees, each visible in the code path the server actually takes:
//  1. the coverage guard checks FIGURES, not only words of 4+ letters — as a
//     diagnostic since P0 (2026-11-07): a figure gap is measured and reported,
//     but the model's reading still ships;
//  2. nothing is refused into a rejected/ layer any more — the chunk ships with
//     its measured gap and document.mechanical.md stays beside it;
//  3. identical bytes + identical settings reuse the finished artefact instead
//     of re-running the whole pipeline (force:true reconverts).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const pdf = 'H:/Ingest_TestFiles/GSB_11_Anwendungshandbuch_11.2.4.pdf';
if (!fs.existsSync(pdf)) {
    console.log('  skip facts/reuse test (test corpus absent)');
    process.exit(0);
}

const agent = await import('../src/agents/nconvert/index.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nconvert-facts-reuse-'));
let visionCalls = 0;
let verifyCalls = 0;
let retryPrompt = null;

// The stub reads the authoritative text out of the prompt and returns it with
// every digit stripped: perfect word coverage, zero fact coverage. A plain-text
// prompt is the verification pass — answer it with a fixed report.
await agent.init({
    gateway: {
        async chat({ messages }) {
            const content = messages[0].content;
            if (typeof content === 'string') {
                verifyCalls++;
                return { content: '## Verdict\nconfidence: medium\nUsable as the record, one figure unconfirmed.\n\n## What this audit could not check\nThe page image itself.' };
            }
            visionCalls++;
            const prompt = content.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
            const authoritative = (prompt.match(/<<<TEXT\n([\s\S]*?)\nTEXT>>>/) || [, ''])[1];
            if (visionCalls === 2) retryPrompt = prompt;
            return { content: authoritative.replace(/\d/g, '') };
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
                // The audit is on demand by default; this test exercises it.
                verify: true,
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

const ingestDir = path.join(tmp, 'ingest');
const itemCount = () => fs.readdirSync(ingestDir).length;

async function deepRun(args) {
    const before = agent.getQueue().jobs.length;
    const response = await agent.nconvert_convert({ path: pdf, depth: 'deep', keepOriginal: false, ...args });
    const text = response.content[0].text;
    const jobs = agent.getQueue().jobs;
    if (jobs.length === before) return { text, job: null };
    const job = jobs.at(-1);
    const deadline = Date.now() + 120000;
    while (!['done', 'failed', 'cancelled'].includes(job.state) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return { text, job };
}

try {
    // ── 1 + 2: figures are guarded, rejected work is kept ──────────────────
    const first = await deepRun({});
    check('deep job completes', first.job?.state === 'done', `${first.job?.state}: ${first.job?.error || ''}`);
    check('a missing figure triggers the corrective retry', visionCalls === 2, `visionCalls=${visionCalls}`);

    if (first.job?.state === 'done') {
        const folder = path.join(tmp, first.job.result.item);
        const meta = JSON.parse(fs.readFileSync(path.join(folder, 'meta.json'), 'utf8'));
        const codes = (meta.warnings || []).map((w) => w.code);
        const chunk = meta.deep.chunks[0];

        check('a figure gap no longer discards the reading', chunk.verdict === 'kept-low-coverage', JSON.stringify(chunk));
        check('fact coverage is measured and recorded', chunk.facts === 0 && chunk.coverage > 0.9, JSON.stringify(chunk));
        check('the warning names the figure gap', codes.includes('deep-low-coverage') && /figures 0\.0%/.test(JSON.stringify(meta.warnings)), JSON.stringify(meta.warnings));
        check('the retry asks for the missing figures', /CORRECTION/.test(retryPrompt || '') && /every figure/.test(retryPrompt || ''));

        const manifest = JSON.parse(fs.readFileSync(path.join(folder, 'item.json'), 'utf8'));
        check('nothing is refused into a rejected layer', manifest.layers.rejected === null, JSON.stringify(manifest.layers.rejected));
        const documentMd = fs.readFileSync(path.join(folder, 'document.md'), 'utf8');
        check('the chunk ships as structured with its measured coverage', /^chunks: 1\/1 structured$/m.test(documentMd) && /^coverage: \d+\.\d%$/m.test(documentMd), documentMd.split('\n').slice(0, 14).join(' | '));
        let rejectedFails = false;
        try {
            await agent.nconvert_fetch({ item: manifest.id, layer: 'rejected' });
        } catch (error) {
            rejectedFails = /no rejected candidates/.test(error.message);
        }
        check('fetching the rejected layer fails loudly with the new contract', rejectedFails);

        check('the deep ingest is audited', manifest.verification?.file === 'verification.md' && manifest.layers.verification === 'verification.md', JSON.stringify(manifest.verification));
        check('the audit records its confidence', manifest.verification?.confidence === 'medium', String(manifest.verification?.confidence));
        const reported = fs.readFileSync(path.join(folder, 'verification.md'), 'utf8');
        check('the audit states what it could not check', /What this audit could not check/.test(reported) && /confidence: medium/.test(reported));
    }

    // ── 3: identical bytes reuse the artefact ─────────────────────────────
    const foldersAfterFirst = itemCount();
    const second = await deepRun({});
    check('a repeat submit is answered without a job', second.job === null);
    check('the reuse is stated, not silent', /Already ingested — reusing/.test(second.text), second.text.split('\n')[0]);
    check('no second artefact folder is written', itemCount() === foldersAfterFirst, `${foldersAfterFirst} → ${itemCount()}`);
    check('reuse spends no audit call either', verifyCalls === 1, String(verifyCalls));

    const forced = await deepRun({ force: true });
    check('force:true reconverts', forced.job?.state === 'done' && itemCount() === foldersAfterFirst + 1, `${forced.job?.state}, ${itemCount()} folders`);

    // ── mechanical reuse on a small text file ─────────────────────────────
    const txt = path.join(tmp, 'reuse-probe.txt');
    fs.writeFileSync(txt, 'Ein kurzer Text mit dem Betrag 1.234,56 EUR.\n\nZweiter Absatz.', 'utf8');
    const a = await agent.nconvert_convert({ path: txt });
    const b = await agent.nconvert_convert({ path: txt });
    check('mechanical repeat is reused', /Already ingested — reusing/.test(b.content[0].text), b.content[0].text.split('\n')[0]);
    check('mechanical first call converted', /document\.md/.test(a.content[0].text));
} finally {
    await agent.shutdown();
    fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
