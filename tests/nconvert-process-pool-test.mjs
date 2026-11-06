import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NativeProcessPool } from '../src/agents/nconvert/native-process-pool.js';

let failures = 0;
function check(name, condition, detail = '') {
    if (condition) console.log(`  ok   ${name}`);
    else { failures++; console.error(`  FAIL ${name} ${detail}`); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nconvert-process-pool-'));
const results = path.join(tmp, 'results');
const pool = new NativeProcessPool({
    size: 4,
    workerFile: path.resolve('src/agents/nconvert/native-worker.js'),
    tmpDir: results
});

try {
    const source = path.join(tmp, 'data.csv');
    fs.writeFileSync(source, 'a,b\n1,2\n');
    const conversions = await Promise.all(Array.from({ length: 8 }, () => pool.run({
        op: 'convert', source, filename: 'data.csv', optionsJson: '{}'
    })));
    check('native conversions run through the pool', conversions.every((envelope) => JSON.parse(envelope).format === 'csv'));
    check('pool stays bounded and reuses workers', pool.workers.size > 1 && pool.workers.size <= 4, `${pool.workers.size}`);
    check('conversion result files are cleaned up', fs.readdirSync(results).length === 0, fs.readdirSync(results).join(','));

    const bad = path.join(tmp, 'bad.bin');
    fs.writeFileSync(bad, Buffer.from([0, 1, 2, 3]));
    let refused = false;
    try {
        await pool.run({ op: 'convert', source: bad, filename: 'bad.bin', optionsJson: '{}' });
    } catch {
        refused = true;
    }
    check('native failure reaches the caller', refused);
    const afterFailure = JSON.parse(await pool.run({ op: 'convert', source, filename: 'data.csv', optionsJson: '{}' }));
    check('worker remains usable after a refused conversion', afterFailure.format === 'csv');

    const pdf = 'H:/Ingest_TestFiles/GSB_11_Anwendungshandbuch_11.2.4.pdf';
    if (fs.existsSync(pdf)) {
        const renders = await Promise.all([0, 1].map((folder) => pool.run({
            op: 'render',
            source: pdf,
            dllDir: path.resolve('nConvert/napi/pdfium/bin'),
            targetWidth: 900,
            maxPages: 2,
            onlyPages: [0],
            folder: path.join(tmp, `render-${folder}`)
        })));
        check('independent PDFium processes render concurrently', renders.every((result) => result.pages.length === 1));
        const png = fs.readFileSync(renders[0].pages[0].file);
        check('worker writes a real PNG directly to the artefact folder', png.subarray(0, 4).toString('hex') === '89504e47');
        const reused = await pool.run({
            op: 'render',
            source: pdf,
            dllDir: path.resolve('nConvert/napi/pdfium/bin'),
            targetWidth: 900,
            maxPages: 2,
            onlyPages: [1],
            folder: path.join(tmp, 'render-reuse')
        });
        check('a persistent worker reuses its PDFium binding', reused.pages.length === 1 && reused.pages[0].index === 1);
    } else {
        console.log('  skip PDFium render (test corpus absent)');
    }
} finally {
    await pool.close();
}

let closedRefused = false;
try {
    await pool.run({ op: 'convert', source: 'unused', filename: 'unused', optionsJson: '{}' });
} catch {
    closedRefused = true;
}
check('closed pool refuses new work', closedRefused);
fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
