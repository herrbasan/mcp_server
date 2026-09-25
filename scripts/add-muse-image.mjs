// Add meta/muse-image to the gateway and hot-reload.
const GW = 'http://localhost:3400';
const KEY = 'someKey33!!';
const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` };

const res = await fetch(`${GW}/config`, { headers });
if (!res.ok) throw new Error(`GET /config failed: ${res.status}`);
const config = await res.json();

// Reuse the OpenRouter key from the existing krea-2-image entry
const apiKey = config.models['krea-2-image']?.apiKey;
if (!apiKey) throw new Error('krea-2-image entry missing — no key source');

config.models['muse-image'] = {
    prettyName: 'Meta Muse Image (OpenRouter)',
    type: 'image',
    adapter: 'openai',
    tier: 'cloud',
    cost: 'low',
    speed: 'fast',
    notes: 'Meta Muse image model via OpenRouter. Cheapest image option — added 2026-09-25 for testing. Aspect ratio support unknown; size/aspect_ratio passed through (no declared set).',
    endpoint: 'https://openrouter.ai/api/v1',
    apiKey,
    adapterModel: 'meta/muse-image',
    capabilities: {
        aspectRatios: ['1:1', '4:3', '3:2', '16:9', '4:5', '2:3', '9:16']
    }
};

const save = await fetch(`${GW}/config/store`, { method: 'POST', headers, body: JSON.stringify(config) });
if (!save.ok) throw new Error(`POST /config/store failed: ${save.status} ${await save.text()}`);
console.log('saved:', JSON.stringify(await save.json()));

const check = await fetch(`${GW}/v1/models?type=image`, { headers });
const models = await check.json();
console.log('image models now:', models.data.map(m => m.id).join(', '));
