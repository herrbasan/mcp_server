import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as resources from '../src/agents/storage/resource-provider.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpRoot = path.join(__dirname, 'tmp_resource_smoke');

function cleanup() {
    if (fs.existsSync(tmpRoot)) fs.rmSync(tmpRoot, { recursive: true, force: true });
}

function assert(condition, message) {
    if (!condition) throw new Error(`ASSERT FAILED: ${message}`);
}

function run() {
    cleanup();
    fs.mkdirSync(tmpRoot, { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'hello.txt'), 'hello world', 'utf8');
    fs.writeFileSync(path.join(tmpRoot, 'nested', 'deep.md'), '# deep', 'utf8');

    const testPublicUrl = 'http://192.168.0.100:3100';
    resources.initResourceProvider({
        storageRoot: tmpRoot,
        translator: null,
        publicUrl: testPublicUrl,
        inlineByteLimit: 64
    });

    // listResources
    const list = resources.listResources();
    assert(Array.isArray(list.resources), 'resources should be an array');
    assert(list.resources.length === 3, `expected 3 resources, got ${list.resources.length}`);
    const uris = list.resources.map(r => r.uri).sort();
    assert(uris.includes('storage://hello.txt'), 'hello.txt missing');
    assert(uris.includes('storage://nested'), 'nested dir missing');
    assert(uris.includes('storage://nested/deep.md'), 'deep.md missing');

    const dirRes = list.resources.find(r => r.uri === 'storage://nested');
    assert(dirRes.annotations?.directory === true, 'nested should have directory annotation');

    // readResource text
    const textRead = resources.readResource({ uri: 'storage://hello.txt' });
    assert(Array.isArray(textRead) && textRead.length === 1, 'text read should return one content item');
    assert(textRead[0].text === 'hello world', 'text content mismatch');
    assert(textRead[0].mimeType === 'text/plain', 'text mime mismatch');
    assert(textRead[0].blob === undefined, 'text item should not have blob field');

    // readResource markdown
    const mdRead = resources.readResource({ uri: 'storage://nested/deep.md' });
    assert(mdRead[0].mimeType === 'text/markdown', 'markdown mime mismatch');
    assert(mdRead[0].text === '# deep', 'markdown content mismatch');

    // readResource base64
    const b64Read = resources.readResource({ uri: 'storage://hello.txt', encoding: 'base64' });
    assert(b64Read[0].blob === Buffer.from('hello world').toString('base64'), 'base64 content mismatch');
    assert(b64Read[0].text === undefined, 'base64 item should not have text field');

    // readResource oversized returns HTTP pointer
    const bigPath = path.join(tmpRoot, 'big.bin');
    fs.writeFileSync(bigPath, Buffer.alloc(128));
    const bigRead = resources.readResource({ uri: 'storage://big.bin' });
    assert(bigRead[0].text.includes(testPublicUrl), 'oversized item should include public URL');
    assert(bigRead[0].text.includes('too large to inline'), 'oversized item should explain it is not inlined');

    // readResource missing
    let threw = false;
    try {
        resources.readResource({ uri: 'storage://missing.txt' });
    } catch (e) {
        threw = true;
    }
    assert(threw, 'missing resource should throw');

    // listResourceTemplates
    const templates = resources.listResourceTemplates();
    assert(Array.isArray(templates) && templates.length === 1, 'expected one resource template');
    assert(templates[0].uriTemplate === 'storage://{path}', 'unexpected template');

    cleanup();
    console.log('All resource-provider smoke tests passed.');
}

run();
