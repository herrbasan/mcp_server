import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const pdf = 'H:/Ingest_TestFiles/GSB_11_Anwendungshandbuch_11.2.4.pdf';
if (!fs.existsSync(pdf)) {
    console.log('  skip deep agent smoke (test corpus absent)');
    process.exit(0);
}

const agent = await import('../src/agents/nconvert/index.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nconvert-deep-smoke-'));
let imageCounts = [];
let visionModels = [];
let visionCalls = 0;
await agent.init({
    gateway: {
        async chat({ model, messages }) {
            visionModels.push(model);
            imageCounts.push(messages[0].content.filter((part) => part.type === 'image_url').length);
            visionCalls++;
            if (visionCalls === 1) return { content: '' };
            return { content: '# DKV\n\nDeep conversion path verified with a stubbed provider.' };
        }
    },
    config: {
        agents: {
            storage: { root: tmp },
            nconvert: {
                nativeProcesses: 2,
                maxDeepPages: 4,
                chunkPages: 2,
                coverageThreshold: 0,
                coverageRetry: false,
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
    const queue = agent.getQueue();
    const job = queue.jobs.at(-1);
    const deadline = Date.now() + 30000;
    while (!['done', 'failed', 'cancelled'].includes(job.state) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    check('deep job completes', job.state === 'done', `${job.state}: ${job.error || ''}`);
    check('both vision batches contain parallel-rendered pages', imageCounts.length === 3 && imageCounts.every((count) => count === 2), JSON.stringify(imageCounts));
    const caps = JSON.parse((await agent.nconvert_capabilities()).content[0].text);
    const chain = [caps.deep.visionModel, ...caps.deep.visionFallbackModels];
    check('empty primary response falls back to the next provider', JSON.stringify(visionModels) === JSON.stringify([chain[0], chain[1], chain[0]]), `${JSON.stringify(visionModels)} vs ${JSON.stringify(chain)}`);
    if (job.state === 'done') {
        const folder = path.join(tmp, job.result.item);
        const pages = [1, 2, 3, 4].map((page) => path.join(folder, 'pages', `page-${String(page).padStart(3, '0')}.png`));
        check('deep artefact includes all pages across reused worker batches', pages.every((page) => fs.existsSync(page)));
        const meta = JSON.parse(fs.readFileSync(path.join(folder, 'meta.json'), 'utf8'));
        check('deep metadata records four rendered pages', meta.deep?.pagesRendered === 4, JSON.stringify(meta.deep));
        check('deep metadata records the providers that answered', meta.deep?.chunks?.[0]?.model === chain[1] && meta.deep?.chunks?.[1]?.model === chain[0], `${JSON.stringify(meta.deep?.chunks?.map((c) => c.model))} vs chain ${JSON.stringify(chain)}`);
        check('mechanical layer is preserved', fs.existsSync(path.join(folder, 'document.mechanical.md')));
    }
} finally {
    await agent.shutdown();
    fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
