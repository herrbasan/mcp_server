// Smoke test for stylereview agent: Tier-0 on live /nconvert + SVG overlap detection.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { init, stylereview_review } from '../src/agents/stylereview/index.js';

let critiqueRequest;

await init({
    config: { agents: { stylereview: { model: 'deepseek-flash-chat' } } },
    gateway: {
        chat: async (request) => {
            critiqueRequest = request;
            return { content: `Mock critique received ${request.messages[0].content.length} chars of Tier-0 metrics.` };
        }
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
assert.match(critiqueRequest.systemPrompt, /NUI reference file: documentation\/components\/dialog\.md/);
assert.match(critiqueRequest.systemPrompt, /NUI reference file: documentation\/addons\/list\.md/);
assert.match(critiqueRequest.systemPrompt, /NUI reference file: LLM-CHEATSHEET\.md/);
assert.match(critiqueRequest.messages[0].content, /"nuiCatalog"/);
console.log('[pass] /nconvert Tier-0 + full NUI documentation injection OK');

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

// 3. NUI audit sees dormant dialog controls and validates exact wrapper types.
const tmpNui = path.join(os.tmpdir(), `stylereview-nui-${Date.now()}.html`);
fs.writeFileSync(tmpNui, `<!doctype html><html><head><link rel="stylesheet" href="nui-theme.css"></head><body>
<nui-app><nui-main><nui-page>
<nui-button><button id="wrapped-button">Wrapped</button></nui-button>
<div class="nui-list-item" style="display:block;position:relative;width:300px;height:20px;border-top:1px solid transparent"><span id="virtual-overflow" style="display:block;margin-top:25px">Overflowing model</span></div>
<dialog id="dormant">
  <button id="raw-button">Raw</button>
  <select id="raw-select"><option>Raw</option></select>
  <nui-select><select id="wrapped-select"><option>Wrapped</option></select></nui-select>
  <input id="raw-text" type="text">
  <input id="raw-checkbox" type="checkbox">
  <input id="raw-radio" type="radio">
  <input id="raw-range" type="range">
  <input id="metadata" type="hidden">
  <textarea id="raw-textarea"></textarea>
  <nui-input><input id="wrapped-text" type="text"></nui-input>
  <nui-checkbox><input id="wrapped-checkbox" type="checkbox"></nui-checkbox>
  <nui-radio><input id="wrapped-radio" type="radio"></nui-radio>
  <nui-slider><input id="wrapped-range" type="range"></nui-slider>
  <nui-textarea><textarea id="wrapped-textarea"></textarea></nui-textarea>
  <form id="provider-form"><nui-input><input name="id" type="text"></nui-input></form>
  <nui-list><button id="list-sort">Sort</button></nui-list>
  <nui-input><button id="input-icon">Icon</button><input type="text"></nui-input>
</dialog>
</nui-page></nui-main></nui-app>
</body></html>`, 'utf8');

try {
    const resNui = await stylereview_review({ target: tmpNui, tier0Only: true });
    assert.equal(resNui.isError, false);
    const parsed = JSON.parse(resNui.content[0].text);
    const nui = parsed.viewports[0].metrics.nui;
    const issues = Object.fromEntries(nui.issues.map((issue) => [issue.rule, issue]));
    for (const [rule, id] of [
        ['bare-button', 'raw-button'], ['bare-select', 'raw-select'],
        ['bare-input', 'raw-text'], ['bare-checkbox', 'raw-checkbox'],
        ['bare-radio', 'raw-radio'], ['bare-range', 'raw-range'],
        ['bare-textarea', 'raw-textarea']
    ]) {
        assert.equal(issues[rule]?.count, 1, `${rule} should flag only the unwrapped control`);
        assert.equal(issues[rule]?.hiddenCount, 1, `${rule} should include dormant dialog controls`);
        assert.match(issues[rule]?.samples[0] || '', new RegExp(`${id}.*hidden`), `${rule} names the dormant control`);
    }
    assert.ok(nui.tagsUsed.includes('nui-select'), 'hidden NUI wrappers appear in tagsUsed');
    assert.doesNotMatch(resNui.content[0].text, /\[object HTMLInputElement\]/, 'a form input named id does not corrupt selectors');
    const virtualIssues = parsed.viewports[0].metrics.layout.virtualRowIssues;
    assert.ok(virtualIssues.some((issue) => issue.content.includes('#virtual-overflow')), 'virtual row content overflow is detected');
    console.log('[pass] full-DOM NUI wrapper audit OK');
} finally {
    fs.unlinkSync(tmpNui);
}

// 4. NUI contracts expose misuse/opportunities and interaction probing follows a revealed task flow.
const tmpFlowDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stylereview-flow-'));
const tmpFlow = path.join(tmpFlowDir, 'page.html');
const tmpFlowNuiCss = path.join(tmpFlowDir, 'nui-theme.css');
fs.writeFileSync(tmpFlowNuiCss, 'nui-card { border: 9px solid green; }', 'utf8');
fs.writeFileSync(tmpFlow, `<!doctype html><html><head><link rel="stylesheet" href="nui-theme.css">
<style>
.custom-card { box-shadow: 0 4px 12px rgba(0,0,0,0.3); }
#wrong-select { padding: 12px; }
.token-only { --color-highlight: red; }
</style></head><body>
<nui-app><nui-content><nui-main><nui-page>
<h1>Settings</h1>
<nui-card id="custom-card" class="custom-card" style="margin-top: 20px">Custom card</nui-card>
<nui-card id="token-card" class="token-only">Token-only theme override</nui-card>
<nui-button id="custom-button"><button type="button" style="background: blue">Custom button</button></nui-button>
<nui-tabs id="settings-tabs">
  <nav>
    <button id="general" type="button" aria-selected="true">General</button>
    <button id="advanced" type="button">Advanced</button>
  </nav>
  <section id="general-panel">General preferences</section>
  <section id="advanced-panel" hidden>
    Advanced preferences
    <button id="open-advanced" type="button">Open advanced preferences</button>
  </section>
</nui-tabs>
<nui-dialog id="advanced-dialog">
  <dialog>
    <h2>Advanced preferences</h2>
    <form method="dialog"><button id="save-advanced">Save</button></form>
  </dialog>
</nui-dialog>
<nui-select id="wrong-select"><input id="wrong-inner"></nui-select>
<nui-checkbox id="wrong-checkbox"><input id="unlabelled-check" type="checkbox"></nui-checkbox>
<nui-input id="wrong-attribute" required><input id="attribute-target"></nui-input>
<dialog id="raw-dialog"><p>Native dialog</p></dialog>
<table id="raw-table"><thead><tr><th>Name</th></tr></thead><tbody><tr><td>Example</td></tr></tbody></table>
</nui-page></nui-main></nui-content></nui-app>
<script>
const general = document.querySelector('#general');
const advanced = document.querySelector('#advanced');
const generalPanel = document.querySelector('#general-panel');
const advancedPanel = document.querySelector('#advanced-panel');
general.onclick = () => {
  general.setAttribute('aria-selected', 'true');
  advanced.removeAttribute('aria-selected');
  generalPanel.hidden = false;
  advancedPanel.hidden = true;
};
advanced.onclick = () => {
  advanced.setAttribute('aria-selected', 'true');
  general.removeAttribute('aria-selected');
  advancedPanel.hidden = false;
  generalPanel.hidden = true;
};
document.querySelector('#open-advanced').onclick = () => {
  document.querySelector('#advanced-dialog dialog').showModal();
};
</script>
</body></html>`, 'utf8');

try {
    const resFlow = await stylereview_review({
        target: tmpFlow,
        viewports: [{ name: 'desktop', width: 1440, height: 900 }],
        probeInteractions: true,
        tier0Only: true
    });
    assert.equal(resFlow.isError, false);
    const parsed = JSON.parse(resFlow.content[0].text);
    const viewport = parsed.viewports[0];
    const issues = Object.fromEntries(viewport.metrics.nui.issues.map((issue) => [issue.rule, issue]));
    assert.match(issues['invalid-inner-element']?.samples.join(' ') || '', /wrong-select.*<select>/);
    assert.equal(issues['checkable-missing-label']?.count, 1);
    assert.equal(issues['native-attribute-on-wrapper']?.count, 1);
    assert.equal(issues['custom-nui-styling']?.count, 4);
    const customStyles = viewport.metrics.nui.customStyles;
    assert.ok(customStyles.some((item) => item.el.startsWith('nui-card#custom-card') && item.source === 'inline'));
    assert.ok(customStyles.some((item) => item.el === 'button' && item.properties.some((property) => /^background(?:-color)?:/.test(property))));
    assert.ok(customStyles.some((item) => item.selector === '.custom-card'));
    assert.ok(customStyles.some((item) => item.selector === '#wrong-select'));
    assert.ok(!customStyles.some((item) => item.el.startsWith('nui-card#token-card')), 'token-only declarations are allowed');
    assert.ok(!customStyles.some((item) => item.sheet?.endsWith('nui-theme.css')), 'NUI library CSS is excluded');
    const opportunities = Object.fromEntries(viewport.metrics.nui.opportunities.map((item) => [item.rule, item]));
    assert.equal(opportunities['native-dialog']?.component, 'nui-dialog');
    assert.equal(opportunities['native-table']?.component, 'nui-table');

    const advancedFlow = viewport.interactionFlows.find((flow) => flow.name === 'Advanced');
    assert.ok(advancedFlow, 'expected the Advanced usage flow');
    assert.ok(advancedFlow.steps.length >= 2, 'the flow should follow the control revealed by the Advanced tab');
    assert.equal(advancedFlow.steps[0].after.activeTabs[0]?.label, 'Advanced');
    assert.equal(advancedFlow.steps[1].action.label, 'Open advanced preferences');
    assert.ok(advancedFlow.steps[1].after.openDialogs.some((dialog) => dialog.el === 'dialog'), 'the followed flow records the opened dialog');
    assert.ok(!advancedFlow.steps.some((step) => step.action.label === 'Save'), 'the probe must not submit the dialog form');
    console.log('[pass] NUI contract audit + multi-step UX flow OK');
} finally {
    fs.unlinkSync(tmpFlow);
    fs.unlinkSync(tmpFlowNuiCss);
    fs.rmdirSync(tmpFlowDir);
}
