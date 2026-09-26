// Standalone dry-run of the usage-monitor cycle without the MCP server.
// Imports the agent module and runs runCycle() — but runCycle is not exported,
// so this harness replicates init() + usage_scan() through the public surface.
import { init, usage_scan, usage_status, shutdown } from '../src/agents/usage-monitor/index.js';

const ctx = { config: { agents: { 'usage-monitor': { intervalMinutes: 0, autoStart: false } } } };
await init(ctx);

console.log('--- running one cycle ---');
const res = await usage_scan({}, {});
const text = res.content[0].text;
const state = JSON.parse(text);
console.log(`updatedAt: ${state.updatedAt}`);
console.log(`stale: ${JSON.stringify(state.stale)}`);
for (const [name, p] of Object.entries(state.providers || {})) {
    const wins = (p.windows || []).map(w =>
        `${w.kind}:${w.usedPct != null ? w.usedPct + '%' : (w.used != null ? w.used + '/' + w.limit : 'rem ' + w.remaining)}${w.model ? '(' + w.model + ')' : ''}`
    ).join(' ');
    console.log(`${name.padEnd(10)} ${p.stale ? '[STALE] ' : ''}${wins}`);
}
console.log('--- status ---');
console.log((await usage_status({}, {})).content[0].text);
await shutdown();
