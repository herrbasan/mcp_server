// Planted: fs boundary, ?? default masking config absence.
import fs from 'fs';
import { slugify } from './util.js';

const settings = { dataDir: null, maxRecords: 1000 };

export function dataPath() {
    const dir = settings.dataDir ?? '/tmp/default-data';
    return `${dir}/records.json`;
}

export function loadRecords() {
    const raw = fs.readFileSync(dataPath(), 'utf8');
    return JSON.parse(raw);
}

export function saveRecords(records) {
    if (records.length > settings.maxRecords) throw new Error(`record count ${records.length} exceeds cap ${settings.maxRecords}`);
    fs.mkdirSync(settings.dataDir, { recursive: true });
    fs.writeFileSync(dataPath(), JSON.stringify(records));
    return records.length;
}

export function recordId(name) {
    return slugify(name);
}
