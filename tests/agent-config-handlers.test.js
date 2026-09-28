// Guard: every tool advertised in an agent's config.json must have an exported
// function of the same name in that agent's index.js. The agent loader calls
// process.exit(1) when one is missing, so a typo here takes the whole server
// down at boot — a failure worth catching in a test rather than at startup.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const agentsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'agents');

const folders = fs.readdirSync(agentsDir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .filter(name => fs.existsSync(path.join(agentsDir, name, 'config.json')));

for (const folder of folders) {
    const configPath = path.join(agentsDir, folder, 'config.json');
    const index = path.join(agentsDir, folder, 'index.js');

    test(`agent '${folder}': every configured tool has an exported handler`, async () => {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        assert.ok(config.agent, `${folder}/config.json has no "agent"`);
        assert.ok(Array.isArray(config.tools), `${folder}/config.json has no tools array`);
        assert.ok(fs.existsSync(index), `${folder} has tools but no index.js`);

        const mod = await import(pathToFileURL(index).href);
        const missing = config.tools
            .filter(t => t.name)
            .filter(t => typeof mod[t.name] !== 'function')
            .map(t => t.name);

        assert.deepEqual(missing, [], `${folder} is missing exported handlers: ${missing.join(', ')}`);
        // init() is optional — the loader only calls it when present (the
        // research agent has none), so nothing to assert about it here.
    });
}

test('every COMPACT_TO_LEGACY target resolves to a loaded tool', async () => {
    const serverSrc = fs.readFileSync(
        path.join(agentsDir, '..', 'server.js'), 'utf8'
    );
    const block = /const COMPACT_TO_LEGACY\s*=\s*\{([\s\S]*?)\n\s*\};/.exec(serverSrc);
    assert.ok(block, 'COMPACT_TO_LEGACY not found in server.js');

    const map = new Function(`return {${block[1]}}`)();
    const targets = new Set(Object.values(map));

    // Collect every tool name the loader will register.
    const known = new Set();
    for (const folder of folders) {
        const config = JSON.parse(fs.readFileSync(path.join(agentsDir, folder, 'config.json'), 'utf8'));
        for (const t of config.tools) if (t.name) known.add(t.name);
    }

    const dangling = [...targets].filter(t => !known.has(t));
    assert.deepEqual(dangling, [], `COMPACT_TO_LEGACY points at tools that do not exist: ${dangling.join(', ')}`);
});
