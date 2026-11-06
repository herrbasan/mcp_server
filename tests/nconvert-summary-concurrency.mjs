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
            nconvert: { nativeProcesses: 2, maxConcurrentJobs: 4, maxSummaryJobs: 1, summary: true }
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
    check('summaries use explicit cloud models', models.every((model) => ['deepseek-flash-chat', 'minimax-m31-flash-chat'].includes(model)), JSON.stringify(models));
    check('primary failure falls back to the second cloud model', models[0] === 'deepseek-flash-chat' && models[1] === 'minimax-m31-flash-chat', JSON.stringify(models));
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
