import { createFileOps } from '../src/lib/fileops.js';
import fs from 'fs';
import os from 'os';
import path from 'path';

const root = path.join(os.tmpdir(), 'fotest-' + Date.now());
fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
fs.writeFileSync(path.join(root, 'a.txt'), 'hello marker world');
fs.writeFileSync(path.join(root, 'sub', 'b.txt'), 'marker\nmarker');
const ops = createFileOps({ root });

const dir = await ops.find('', 'marker');
console.log('dir mode:', JSON.stringify(dir, null, 1));
if (!dir.found || dir.count !== 3 || dir.files.length !== 2) throw new Error('dir mode FAILED');

const file = await ops.find('sub/b.txt', 'marker');
console.log('file mode:', JSON.stringify(file));
if (!file.found || file.count !== 2) throw new Error('file mode FAILED');

console.log('ALL PASS');
fs.rmSync(root, { recursive: true, force: true });
