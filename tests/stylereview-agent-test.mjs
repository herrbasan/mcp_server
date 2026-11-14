// Smoke test for stylereview agent: Tier-0 on live /nconvert + SVG overlap detection.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { init, stylereview_review } from '../src/agents/stylereview/index.js';

await init({
    config: { agents: { stylereview: { model: 'deepseek-flash-chat' } } },
    gateway: {
        chat: async ({ messages }) => ({
            content: `Mock critique received ${messages[0].content.length} chars of Tier-0 metrics.`
        })
    }
});

// 1. Live /nconvert UI (Tier-0 + mock LLM)
const resHtml = await stylereview_review({
    target: 'http://127.0.0.1:3100/nconvert',
    viewports: [{ name: 'desktop', width: 1440, height: 900 }],
    probeInteractions: true
});
assert.equal(resHtml.isError, false);
const htmlText = resHtml.content[0].text;
assert.match(htmlText, /bare-button/);
assert.match(htmlText, /missing-nui-shell/);
assert.match(htmlText, /wrapped-controls|emptyFlowBoxes/);
console.log('[pass] /nconvert Tier-0 + report OK');

// 2. SVG overlap + clipping detection (tier0Only)
const tmpSvg = path.join(os.tmpdir(), `stylereview-test-${Date.now()}.svg`);
fs.writeFileSync(tmpSvg, `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="120" viewBox="0 0 300 120">
  <text x="10" y="30" font-size="14">Label A</text>
  <text x="14" y="30" font-size="14">Label B</text>
  <text x="295" y="60" font-size="8">ClippedTiny</text>
</svg>`, 'utf8');

try {
    const resSvg = await stylereview_review({ target: tmpSvg, tier0Only: true });
    assert.equal(resSvg.isError, false);
    const parsed = JSON.parse(resSvg.content[0].text);
    const svg0 = parsed.viewports[0].metrics.svg[0];
    assert.ok(svg0, 'expected SVG issues');
    assert.ok(svg0.textOverlaps.length >= 1, 'expected textOverlap');
    assert.ok(svg0.clippedTexts.length >= 1, 'expected clippedText');
    assert.ok(svg0.tinySvgText.length >= 1, 'expected tinySvgText');
    console.log('[pass] SVG overlap/clipping/tiny-text detection OK');
} finally {
    fs.unlinkSync(tmpSvg);
}
