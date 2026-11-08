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
} finally {
    await agent.shutdown();
    fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
