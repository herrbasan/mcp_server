// M1 smoke test: drives the real agent (init + nconvert_convert +
// nconvert_capabilities) against a temp storage root. No server required.
// Run: node nConvert/napi/test/smoke.mjs

import fs from 'fs';
import path from 'path';
import os from 'os';

const agent = await import('../src/agents/nconvert/index.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nconvert-smoke-'));
await agent.init({
    config: { agents: { storage: { root: tmp }, nconvert: {} } }
});

let failures = 0;
function check(name, cond, detail = '') {
    if (cond) {
        console.log(`  ok   ${name}`);
    } else {
        failures++;
        console.error(`  FAIL ${name} ${detail}`);
    }
}

// The response's first line is the ingest folder — the contract callers rely on.
function folderOf(result) {
    const m = /→ (ingest\/\S+)\//.exec(result.content[0].text);
    if (!m) throw new Error(`no folder in response: ${result.content[0].text}`);
    return path.join(tmp, m[1]);
}

// ── txt ──
fs.writeFileSync(path.join(tmp, 'note.txt'), 'first para\n\nsecond para\n');
let r = await agent.nconvert_convert({ path: 'note.txt' });
check('txt converts', !r.isError);
let md = fs.readFileSync(path.join(folderOf(r), 'document.md'), 'utf8');
check('txt ingest folder complete',
    fs.existsSync(path.join(folderOf(r), 'meta.json')) &&
    fs.existsSync(path.join(folderOf(r), 'original.txt')));
check('txt paragraphs survive', md.includes('first para') && md.includes('second para'));

// ── csv (german semicolon + quoted) ──
fs.writeFileSync(path.join(tmp, 'daten.csv'), 'Name;Ort\n"Müller, Anna";Köln\n"Meier";"Berlin\nMitte"\n');
r = await agent.nconvert_convert({ path: 'daten.csv' });
check('csv converts', !r.isError, JSON.stringify(r).slice(0, 200));
md = fs.readFileSync(path.join(folderOf(r), 'document.md'), 'utf8');
check('csv quoted commas survive', md.includes('Müller, Anna') || md.includes('M\\u00fcller'), md.slice(0, 300));
check('csv newline-in-quotes becomes <br>', md.includes('Berlin<br>Mitte'));

// ── md passthrough keeps MD-Blocks directives ──
fs.writeFileSync(path.join(tmp, 'deck.md'),
    '---\ntitle: My Deck\nauthor: david\n---\n\n# Slide one\n\n<!-- mb:columns weights=[2,1] -->\n<!-- mb:col -->\nleft\n<!-- mb:col preset=card -->\nright\n<!-- mb:/columns -->\n');
r = await agent.nconvert_convert({ path: 'deck.md' });
check('md converts', !r.isError);
md = fs.readFileSync(path.join(folderOf(r), 'document.md'), 'utf8');
check('md: mb:columns survives verbatim', md.includes('mb:columns weights=[2,1]'), md.slice(0, 400));
check('md: user frontmatter preserved', md.includes('author: david'));
check('md: converter frontmatter added', md.includes('converter: nconvert'));

// ── json valid + invalid ──
fs.writeFileSync(path.join(tmp, 'conf.json'), '{"z": [1, 2], "a": {"b": true}}');
r = await agent.nconvert_convert({ path: 'conf.json' });
check('json converts', !r.isError);
md = fs.readFileSync(path.join(folderOf(r), 'document.md'), 'utf8');
check('json fenced + pretty', md.includes('```json') && md.includes('\n  "z"'));

fs.writeFileSync(path.join(tmp, 'broken.json'), '{oops');
try {
    await agent.nconvert_convert({ path: 'broken.json' });
    check('invalid json throws', false);
} catch (e) {
    check('invalid json throws with diagnosis', /does not parse/.test(e.message), e.message);
}

// ── pdf: fake bytes fail loud as invalid input (real pdfs live in the corpus) ──
fs.writeFileSync(path.join(tmp, 'doc.pdf'), '%PDF-1.7\nfake\n');
try {
    await agent.nconvert_convert({ path: 'doc.pdf' });
    check('fake pdf fails loud', false);
} catch (e) {
    check('fake pdf fails as invalid', /invalid pdf input/.test(e.message), e.message);
}

// ── image → needs_ocr refusal (M5 pending) ──
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
fs.writeFileSync(path.join(tmp, 'scan.png'), png);
try {
    await agent.nconvert_convert({ path: 'scan.png' });
    check('image refuses', false);
} catch (e) {
    check('image refuses with M5 note', /M5/.test(e.message), e.message);
}

// ── keepOriginal false + collision counter ──
r = await agent.nconvert_convert({ path: 'note.txt', keepOriginal: false });
check('keepOriginal:false honored', !fs.existsSync(path.join(folderOf(r), 'original.txt')));
const folders = fs.readdirSync(path.join(tmp, 'ingest'));
check('collision counter works', folders.some(f => /-\d+$/.test(f)), folders.join(', '));

// ── capabilities ──
r = await agent.nconvert_capabilities();
const caps = JSON.parse(r.content[0].text);
check('capabilities matrix', caps.formats.length === 20 && caps.limits.maxInputMb === 100);

// ── external difficult-documents corpus (H:\Ingest_TestFiles) ──
// Real files, never committed (privacy: medical/financial content).
// Skips with a notice when the drive is absent — the hermetic layers above
// still fully cover the code paths.
const CORPUS = 'H:/Ingest_TestFiles';
if (fs.existsSync(CORPUS)) {
    // Born-digital manual: must extract real text across many pages.
    r = await agent.nconvert_convert({ path: `${CORPUS}/GSB_11_Anwendungshandbuch_11.2.4.pdf`, keepOriginal: false });
    check('corpus: GSB manual extracts', !r.isError && /pdf/.test(r.content[0].text), r.content?.[0]?.text?.slice(0, 200));
    // GSB manual now proves image extraction too.
    if (!r.isError) {
        const m = /→ (ingest\/\S+)\//.exec(r.content[0].text);
        const assetsDir = path.join(tmp, m[1], 'assets');
        const assets = fs.existsSync(assetsDir) ? fs.readdirSync(assetsDir) : [];
        check('corpus: GSB images extracted', assets.length >= 300, `${assets.length} assets`);
        const md = fs.readFileSync(path.join(tmp, m[1], 'document.md'), 'utf8');
        check('corpus: image blocks referenced', (md.match(/assets\/page-/g) || []).length >= 300);
    }
    // Scan + OCR-layer documents: success (with possible page warnings) OR M5 refusal — both honest.
    for (const f of ['DKV_Bescheinigung für FA 2022.pdf', 'Klinikum Ingolstadt_Entlassungsbrief11.03.13.pdf']) {
        try {
            r = await agent.nconvert_convert({ path: `${CORPUS}/${f}`, keepOriginal: false });
            check(`corpus: ${f.slice(0, 20)}… converts or warns`, !r.isError || /M5/.test(r.content[0].text));
        } catch (e) {
            check(`corpus: ${f.slice(0, 20)}… refuses to M5`, /M5/.test(e.message), e.message.slice(0, 150));
        }
    }
    // Motherboard guide: AES-256 (V5/R6) permissions-DRM — resolves via lopdf
    // 0.46's auto-decrypt (empty user password). Text + JPX diagrams must flow.
    const mb = `${CORPUS}/E19165_ROG_STRIX_Z690-F_GAMING_WIFI_UM_V2_WEB.pdf`;
    if (fs.existsSync(mb)) {
        r = await agent.nconvert_convert({ path: mb, keepOriginal: false });
        check('corpus: motherboard guide converts', !r.isError, r.content?.[0]?.text?.slice(0, 200));
        if (!r.isError) {
            const m = /→ (ingest\/\S+)\//.exec(r.content[0].text);
            const md = fs.readFileSync(path.join(tmp, m[1], 'document.md'), 'utf8');
            check('corpus: motherboard text extracted', md.includes('ROG STRIX'));
            const assetsDir = path.join(tmp, m[1], 'assets');
            const pngs = fs.existsSync(assetsDir) ? fs.readdirSync(assetsDir).filter((a) => a.endsWith('.png')) : [];
            check('corpus: motherboard JPX diagrams as PNG', pngs.length >= 1, `${pngs.length} png`);
        }
    }
    // Word 97-2003 .doc converts since engine 0.6.0 (piece table + Data carving)
    try {
        const r = await agent.nconvert_convert({ path: `${CORPUS}/Zeitsprung_V2.3.doc`, keepOriginal: false });
        check('corpus: legacy doc converts', !r.isError, JSON.stringify(r).slice(0, 200));
        const m = /→ (ingest\/\S+)\//.exec(r.content[0].text);
        const dir = path.join(tmp, m[1]);
        const item = JSON.parse(fs.readFileSync(path.join(dir, 'item.json'), 'utf8'));
        check('corpus: doc has text stats', item.stats.words > 100 && item.stats.figures >= 0, JSON.stringify(item.stats));
        const md = fs.readFileSync(path.join(dir, 'document.md'), 'utf8');
        check('corpus: doc text extracted', md.length > 2000, `${md.length} chars`);
    } catch (e) {
        check('corpus: legacy doc converts', false, e.message.slice(0, 150));
    }
} else {
    console.log('  skip external corpus (H:\\Ingest_TestFiles absent)');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
