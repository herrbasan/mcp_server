// Update muse-image notes with the measured parameter behavior.
const GW = 'http://localhost:3400';
const KEY = 'someKey33!!';
const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` };

const res = await fetch(`${GW}/config`, { headers });
const config = await res.json();

config.models['muse-image'].notes = 'Meta Muse via OpenRouter, cheapest image model (~$0.01), visually strong. MEASURED 2026-09-25: aspect_ratio is bucket-collapsed (16:9/4:3/2:1/21:9 all -> 3:2 1920x1280; 1:1 -> 1600x1600; 9:16/3:4 -> 1280x1920). size "WxH" IS honored as a framing contract at ~2.4MP (e.g. 1920x1080 -> 2048x1152 true 16:9) — send size via extra_body or adapter passthrough. resolution/seed/width/height ignored. Metadata declares supported_parameters:{} (wrong).';

const save = await fetch(`${GW}/config/store`, { method: 'POST', headers, body: JSON.stringify(config) });
if (!save.ok) throw new Error(`save failed: ${save.status} ${await save.text()}`);
console.log('notes updated');
