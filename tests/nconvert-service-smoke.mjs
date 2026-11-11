// nconvert service smoke test — the MCP proxy against a running nTeligence.
//
// This replaces the in-process agent tests (queue, native pool, deep lane):
// after the cutover those modules no longer exist in mcp_server. What is worth
// testing here is the thing this repo still owns — the tool surface — so the
// test drives the exported handlers from index.js exactly as the MCP layer does.
//
// Requires: nteligence-server running (default http://127.0.0.1:3300).
// Run: npm run test:nconvert

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import * as agent from '../src/agents/nconvert/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const config = JSON.parse(fs.readFileSync(path.join(repoRoot, 'config.json'), 'utf8'));

// The corpus stays with the engine (nTeligence/nConvert/corpus); this repo no
// longer carries a copy. Point NCONVERT_CORPUS elsewhere to override.
const CORPUS = process.env.NCONVERT_CORPUS
    || path.resolve(repoRoot, '..', 'nTeligence', 'nConvert', 'corpus', 'tika');
const WORDS = path.join(CORPUS, 'testWORD.docx');
const SCANNED_PDF = path.join(CORPUS, 'testPDF_Version.11.x.PDFA-1b.pdf');

let failures = 0;
function check(label, fn) {
    return Promise.resolve()
        .then(fn)
        .then(() => console.log(`  ok  ${label}`))
        .catch((error) => {
            failures += 1;
            console.error(`  FAIL ${label}\n       ${error.message}`);
        });
}

async function main() {
    const init = await agent.init({ config });
    if (init.status === 'unreachable') {
        console.error(`nTeligence is not reachable at ${init.service} — start it: cd D:\\DEV\\nTeligence; cargo run -p nteligence-server`);
        process.exit(1);
    }
    console.log(`nconvert proxy → ${init.service} (${init.converter})\n`);

    await check('capabilities name the engine and the missing lanes', async () => {
        const result = await agent.nconvert_capabilities();
        const caps = JSON.parse(result.content[0].text);
        assert.match(caps.converter, /^nconvert \d/);
        assert.strictEqual(caps.deep.available, false, 'deep must report as unavailable, not silently degrade');
        assert.ok(Array.isArray(caps.formats) && caps.formats.length > 10);
    });

    let itemId = null;
    await check('convert a docx mechanically', async () => {
        // force, so the check exercises conversion whether or not an earlier run
        // already produced this artefact.
        const result = await agent.nconvert_convert({ path: WORDS, force: true });
        assert.ok(result.result?.id, 'result carries the item id');
        assert.strictEqual(result.result.format, 'docx');
        assert.ok(result.content[0].text.includes('sections'), 'response text should summarise the artefact');
        assert.ok(result.job?.id, 'an inline job record is returned');
        itemId = result.result.id;
    });

    await check('the same bytes are reused, not reconverted', async () => {
        const again = await agent.nconvert_convert({ path: WORDS });
        assert.strictEqual(again.result.id, itemId);
        assert.ok(again.content[0].text.startsWith('Already ingested'), 'reuse is announced, not silent');
    });

    await check('fetch reads the document layer', async () => {
        const fetched = await agent.nconvert_fetch({ item: itemId, layer: 'document', maxChars: 200 });
        assert.strictEqual(fetched.kind, 'text');
        assert.ok(fetched.content[0].text.length > 0);
    });

    await check('fetch a single section', async () => {
        const fetched = await agent.nconvert_fetch({ item: itemId, layer: 'document', section: 0 });
        assert.match(fetched.content[0].text, /^section 0 of \d+/);
    });

    await check('fetch the original as a path, never bytes', async () => {
        const fetched = await agent.nconvert_fetch({ item: itemId, layer: 'original' });
        assert.strictEqual(fetched.kind, 'binary');
        assert.ok(fetched.url.startsWith('/files/'), 'binary layers return a URL');
    });

    await check('items and jobs list the artefact', async () => {
        const items = await agent.nconvert_items({ limit: 5 });
        assert.ok(items.items.some((entry) => entry.id === itemId));
        const jobs = await agent.nconvert_jobs({ limit: 5 });
        assert.ok(jobs.jobs.length > 0);
        const detail = await agent.nconvert_job({ id: jobs.jobs[0].id });
        assert.ok(detail.content[0].text.includes(jobs.jobs[0].id));
    });

    await check('deep is refused with a precise reason', async () => {
        await assert.rejects(
            () => agent.nconvert_convert({ path: WORDS, depth: 'deep' }),
            /deep lane|deep.*not available/i
        );
    });

    await check('a scan without a text layer is refused loudly', async () => {
        await assert.rejects(
            () => agent.nconvert_convert({ path: SCANNED_PDF }),
            /OCR|text layer/i
        );
    });

    await check('an unknown ingest argument is rejected, not dropped', async () => {
        await assert.rejects(
            () => agent.nconvert_convert({ path: WORDS, verify: true }),
            /does not accept verify/
        );
    });

    // Leave one review-UI payload check last: it is the shape ui-api and the
    // Document Chat read.
    await check('item payload carries manifest, document and layers', async () => {
        const payload = await agent.readItemPayload(itemId, { documentChars: 500 });
        assert.strictEqual(payload.manifest.id, itemId);
        assert.ok(payload.document.length > 0);
        assert.strictEqual(typeof payload.documentTruncated, 'boolean');
        assert.ok(payload.documentChars >= payload.document.length);
    });

    if (failures > 0) {
        console.error(`\n${failures} check(s) failed`);
        process.exit(1);
    }
    console.log('\nall checks passed');
}

main().catch((error) => {
    console.error(error.stack ?? error.message);
    process.exit(1);
});
