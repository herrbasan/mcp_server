import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

process.once('message', async (job) => {
    try {
        const native = require('../../../nConvert/napi/index.js');
        const bytes = fs.readFileSync(job.pdfPath);
        const envelope = await native.renderPages(bytes, job.dllDir, job.width, job.limit, job.onlyPages);
        const rendered = JSON.parse(envelope).pages;
        fs.mkdirSync(job.outputDir, { recursive: true });
        const pages = rendered.map((page) => {
            const number = page.index + 1;
            const filename = `page-${String(number).padStart(3, '0')}.png`;
            fs.writeFileSync(path.join(job.outputDir, filename), Buffer.from(page.pngBase64, 'base64'));
            return { page: number, filename };
        });
        process.send({ ok: true, pages }, () => process.exit(0));
    } catch (error) {
        process.send({ ok: false, error: error.stack || error.message }, () => process.exit(1));
    }
});
