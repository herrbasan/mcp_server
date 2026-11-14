// Planted: performance-lens candidates — sync I/O on a hot path, JSON deep
// clone, serial awaits in a loop. No planted defensive bugs.
import fs from 'fs';

export function loadConfig(configPath) {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

export function snapshot(state) {
    return JSON.parse(JSON.stringify(state));
}

export async function fetchAll(ids, endpoint) {
    const results = [];
    for (const id of ids) {
        results.push(await fetch(`${endpoint}/items/${id}`));
    }
    return results;
}
