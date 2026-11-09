import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const agent = await import('../src/agents/nconvert/index.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nconvert-summary-limit-'));
let active = 0;
let maxActive = 0;
let calls = 0;
const models = [];
let failures = 0;
function check(name, condition, detail = '') {
    if (condition) console.log(`  ok   ${name}`);
    else { failures++; console.error(`  FAIL ${name} ${detail}`); }
}

await agent.init({
    gateway: {
        async chat({ model }) {
            active++;
            models.push(model);
            maxActive = Math.max(maxActive, active);
            try {
                await new Promise((resolve) => setTimeout(resolve, 25));
                calls++;
                if (calls === 1) throw new Error('simulated primary-provider failure');
                return { content: 'A concise retrieval summary.' };
            } finally {
                active--;
            }
        }
    },
    config: {
        agents: {
            storage: { root: tmp },
            nconvert: {
                nativeProcesses: 2,
                maxConcurrentJobs: 4,
                maxSummaryJobs: 1,
                summary: true,
                // Production runs summaries on the local model with no chain
                // (2026-11-08). The serialisation and fallback mechanics still
                // have to work for a configured chain, so declare one here.
                summaryModels: ['badkid-llama-chat', 'deepseek-flash-chat']
            }
        }
    }
});

try {
    const files = Array.from({ length: 4 }, (_, index) => {
        const file = path.join(tmp, `note-${index}.txt`);
        fs.writeFileSync(file, `Document ${index}\n\nContent for concurrent summary scheduling.`);
        return file;
    });
    const results = await Promise.all(files.map((file) => agent.nconvert_convert({ path: file, keepOriginal: false })));
    check('parallel mechanical conversions complete', results.every((result) => !result.isError));
    check('summary provider calls stay serial', maxActive === 1, `${maxActive}`);
    check('summaries use the configured chain', models.every((model) => ['badkid-llama-chat', 'deepseek-flash-chat'].includes(model)), JSON.stringify(models));
    check('a failed primary falls back to the next configured model', models[0] === 'badkid-llama-chat' && models[1] === 'deepseek-flash-chat', JSON.stringify(models));
    const summaries = files.map((file) => {
        const match = /→ (ingest\/\S+)\//.exec(results[files.indexOf(file)].content[0].text);
        return fs.existsSync(path.join(tmp, match[1], 'summary.md'));
    });
    check('all queued summaries are written', summaries.every(Boolean));

    // The repair path: an item whose summary failed can gain its L0 layer
    // without re-converting the document.
    const target = /→ (ingest\/\S+)\//.exec(results[0].content[0].text)[1];
    fs.rmSync(path.join(tmp, target, 'summary.md'), { force: true });
    const regenerated = await agent.nconvert_summarize({ item: path.basename(target) });
    check('nconvert.summarize rewrites the L0 layer', !regenerated.isError && fs.existsSync(path.join(tmp, target, 'summary.md')), regenerated.content?.[0]?.text);
    const manifest = JSON.parse(fs.readFileSync(path.join(tmp, target, 'item.json'), 'utf8'));
    check('item.json records the regenerated summary', manifest.layers?.summary === 'summary.md' && Boolean(manifest.summary?.generated), JSON.stringify(manifest.summary));
} finally {
    await agent.shutdown();
    fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
