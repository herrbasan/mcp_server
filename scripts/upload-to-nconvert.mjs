#!/usr/bin/env node
// Upload a file to the MCP server's nConvert ingest route and print the result.
// This is the path for clients that cannot hand the service host a filesystem
// path — notably a browser-based chat app, which does the same POST in fetch().
//
//   node scripts/upload-to-nconvert.mjs "D:\art\deck.pptx" [--host http://127.0.0.1:3100] [--depth mechanical]
//
// The body is streamed, so a 150 MB file never has to sit in this process's
// memory; the server buffers it (express.raw), which is where the RSS cost lands.
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--'));
if (!file) {
    console.error('usage: node scripts/upload-to-nconvert.mjs <file> [--host <url>] [--depth mechanical] [--name slug]');
    process.exit(2);
}
const flag = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? fallback : args[i + 1];
};

const host = flag('host', 'http://127.0.0.1:3100').replace(/\/+$/, '');
if (!fs.existsSync(file)) {
    console.error(`not found: ${file}`);
    process.exit(2);
}
const size = fs.statSync(file).size;

const query = new URLSearchParams({ filename: path.basename(file) });
for (const key of ['depth', 'name', 'keepOriginal', 'assets', 'force']) {
    const value = flag(key, undefined);
    if (value !== undefined) query.set(key, value);
}

const url = `${host}/nconvert/upload?${query.toString()}`;
console.log(`POST ${url} (${(size / 1048576).toFixed(1)} MB)`);
const started = Date.now();

const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: fs.createReadStream(file),
    duplex: 'half'
});
const text = await res.text();
console.log(`HTTP ${res.status} in ${((Date.now() - started) / 1000).toFixed(1)}s`);

let payload;
try {
    payload = JSON.parse(text);
} catch {
    console.log(text);
    process.exit(res.ok ? 0 : 1);
}

if (!res.ok) {
    console.error(payload.error ?? text);
    process.exit(1);
}
// Same shape nconvert.convert returns: result carries the item id.
const result = payload.result ?? payload;
console.log(result.text ?? JSON.stringify({ id: result.id, item: result.item, warnings: result.warnings }));
if (result.id) console.log(`\nitem: ${result.id}\nread it with: nconvert.fetch({ item: "${result.id}", layer: "document" })`);
