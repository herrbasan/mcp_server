import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const native = require('../../../nConvert/napi/index.js');

let busy = false;

process.on('message', async (task) => {
    if (busy) {
        process.send({ id: task.id, ok: false, error: 'native worker received a concurrent task' });
        return;
    }
    busy = true;
    try {
        const bytes = fs.readFileSync(task.source);
        if (task.op === 'convert') {
            const envelope = await native.convert(bytes, task.filename, task.optionsJson);
            fs.writeFileSync(task.resultPath, envelope, 'utf8');
            process.send({ id: task.id, ok: true, result: { resultPath: task.resultPath } });
        } else if (task.op === 'render') {
            const envelope = await native.renderPages(
                bytes,
                task.dllDir,
                task.targetWidth,
                task.maxPages,
                task.onlyPages
            );
            const pages = JSON.parse(envelope).pages;
            fs.mkdirSync(task.folder, { recursive: true });
            const result = [];
            for (const page of pages) {
                const file = path.join(task.folder, `page-${String(page.index + 1).padStart(3, '0')}.png`);
                fs.writeFileSync(file, Buffer.from(page.pngBase64, 'base64'));
                result.push({ index: page.index, width: page.width, height: page.height, file });
            }
            process.send({ id: task.id, ok: true, result: { pages: result } });
        } else if (task.op === 'ocr') {
            const raw = await native.ocrPage(bytes, task.modelDir, task.optionsJson ?? '{}');
            process.send({ id: task.id, ok: true, result: JSON.parse(raw) });
        } else {
            throw new Error(`unknown native operation: ${task.op}`);
        }
    } catch (error) {
        process.send({ id: task.id, ok: false, error: error.message });
    } finally {
        busy = false;
    }
});

process.on('disconnect', () => process.exit(0));
