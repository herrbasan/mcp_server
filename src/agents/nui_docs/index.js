import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const NUI_DIR = join(__dirname, 'nui_wc2');
const PAGES_DIR = join(NUI_DIR, 'Playground', 'pages');
const REGISTRY_PATH = join(NUI_DIR, 'docs', 'components.json');
const THEME_CSS_PATH = join(NUI_DIR, 'NUI', 'css', 'nui-theme.css');
const ICON_SPRITE_PATH = join(NUI_DIR, 'NUI', 'assets', 'material-icons-sprite.svg');

let registry = null;
let assetCache = { commit: null, cssVars: null, icons: null };

function getSubmoduleCommit() {
	try {
		return execSync('git rev-parse HEAD', { cwd: NUI_DIR, encoding: 'utf-8' }).trim();
	} catch {
		return null;
	}
}

function ensureAssetCache() {
	const commit = getSubmoduleCommit();
	if (assetCache.commit === commit) return assetCache;

	let cssVars = [];
	let icons = [];

	try {
		const css = readFileSync(THEME_CSS_PATH, 'utf-8');
		const varRegex = /(--[\w-]+)\s*:\s*([^;}{]+)/g;
		let m;
		while ((m = varRegex.exec(css)) !== null) {
			cssVars.push({ name: m[1], value: m[2].trim() });
		}
	} catch {}

	try {
		const svg = readFileSync(ICON_SPRITE_PATH, 'utf-8');
		const idRegex = /<symbol\s+id="([^"]+)"/g;
		let m;
		while ((m = idRegex.exec(svg)) !== null) {
			icons.push(m[1]);
		}
	} catch {}

	assetCache = { commit, cssVars, icons };
	return assetCache;
}

function loadRegistry() {
	if (registry) return registry;
	try {
		registry = JSON.parse(readFileSync(REGISTRY_PATH, 'utf-8'));
		return registry;
	} catch (err) {
		return null;
	}
}

function readPage(pagePath) {
	const filePath = join(PAGES_DIR, `${pagePath}.html`);
	try {
		return readFileSync(filePath, 'utf-8');
	} catch (err) {
		return null;
	}
}

function extractLlmGuide(html) {
	const match = html.match(/<script\s+type="text\/markdown">([\s\S]*?)<\/script>/);
	if (!match) return null;
	return match[1].trim();
}

function extractCodeExamples(html) {
	const examples = [];
	const regex = /<script\s+type="example"\s+data-lang="(\w+)">([\s\S]*?)<\/script>/gi;
	let match;
	while ((match = regex.exec(html)) !== null) {
		const lang = match[1];
		let code = match[2].trim();
		code = code.replace(/^\n+/, '').replace(/\n+$/, '');
		examples.push({ lang, code });
	}
	return examples;
}

function extractTextContent(html) {
	let text = html;
	text = text.replace(/<script[\s\S]*?<\/script>/gi, '');
	text = text.replace(/<style[\s\S]*?<\/style>/gi, '');
	text = text.replace(/<nui-markdown[\s\S]*?<\/nui-markdown>/gi, '');
	text = text.replace(/<details[\s\S]*?<\/details>/gi, '');
	text = text.replace(/<nui-code[\s\S]*?<\/nui-code>/gi, '');
	text = text.replace(/<br\s*\/?>/gi, '\n');
	text = text.replace(/<\/?(p|h[1-6]|li|div|section|header|footer|main|article|aside|nav|ul|ol|dl|dt|dd|blockquote|pre|figure|figcaption|address)\b[^>]*>/gi, '\n');
	text = text.replace(/<\/?(strong|b|em|i|mark|small|del|ins|sub|sup|abbr|code|kbd|samp|var|cite|q|span|a)\b[^>]*>/gi, '');
	text = text.replace(/<[^>]+>/g, '');
	text = text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
	text = text.replace(/\n{3,}/g, '\n\n');
	const lines = text.split('\n');
	const dedented = lines.map(line => {
		const trimmed = line.replace(/^\t+/, '');
		return trimmed.trimEnd();
	});
	return dedented.join('\n').trim();
}

function formatComponentDoc(name, html) {
	const parts = [];

	const llmGuide = extractLlmGuide(html);
	if (llmGuide) {
		parts.push('## LLM Guide\n\n' + llmGuide);
	}

	const examples = extractCodeExamples(html);
	if (examples.length > 0) {
		parts.push('## Code Examples\n');
		for (const ex of examples) {
			parts.push(`\`\`\`${ex.lang}\n${ex.code}\n\`\`\``);
		}
	}

	const textContent = extractTextContent(html);
	if (textContent) {
		parts.push('## Documentation\n\n' + textContent);
	}

	return parts.join('\n\n');
}

function formatGuideDoc(html) {
	const parts = [];

	const examples = extractCodeExamples(html);
	const textContent = extractTextContent(html);

	if (textContent) {
		parts.push(textContent);
	}

	if (examples.length > 0) {
		parts.push('## Code Examples\n');
		for (const ex of examples) {
			parts.push(`\`\`\`${ex.lang}\n${ex.code}\n\`\`\``);
		}
	}

	return parts.join('\n\n');
}

function errorResponse(msg) {
	return {
		content: [{ type: 'text', text: msg }],
		isError: true
	};
}

function textResponse(text) {
	return { content: [{ type: 'text', text }] };
}

export async function nui_list_components() {
	const reg = loadRegistry();
	if (!reg) return errorResponse('Failed to load component registry.');

	const lines = [];

	if (reg.guides && reg.guides.length > 0) {
		lines.push('## Guides');
		for (const g of reg.guides) {
			lines.push(`- **${g.name}** — ${g.description}`);
		}
		lines.push('');
	}

	const categories = {};
	for (const c of reg.components) {
		const cat = c.category;
		if (!categories[cat]) categories[cat] = [];
		categories[cat].push(c);
	}

	const catOrder = ['layout', 'forms', 'display', 'navigation', 'utility', 'addon'];
	for (const cat of catOrder) {
		if (!categories[cat]) continue;
		const label = cat.charAt(0).toUpperCase() + cat.slice(1);
		lines.push(`## ${label}`);
		for (const c of categories[cat]) {
			lines.push(`- **${c.name}** — ${c.description}`);
		}
		lines.push('');
	}

	return textResponse(lines.join('\n'));
}

export async function nui_get_component(args) {
	const name = args.component;
	if (!name) return errorResponse('Missing required parameter: component');

	const reg = loadRegistry();
	if (!reg) return errorResponse('Failed to load component registry.');

	const entry = reg.components.find(c =>
		c.name.toLowerCase() === name.toLowerCase() ||
		c.name === name
	);

	if (!entry) {
		const available = reg.components.map(c => c.name).join(', ');
		return errorResponse(`Component "${name}" not found. Available: ${available}`);
	}

	const html = readPage(entry.page);
	if (!html) return errorResponse(`Documentation page not found: ${entry.page}`);

	const doc = formatComponentDoc(entry.name, html);
	return textResponse(doc);
}

export async function nui_get_guide(args) {
	const topic = args.topic;
	if (!topic) return errorResponse('Missing required parameter: topic');

	const reg = loadRegistry();
	if (!reg) return errorResponse('Failed to load component registry.');

	const entry = reg.guides?.find(g =>
		g.name.toLowerCase() === topic.toLowerCase() ||
		g.name === topic
	);

	if (!entry) {
		const available = reg.guides?.map(g => g.name).join(', ') || 'none';
		return errorResponse(`Guide "${topic}" not found. Available: ${available}`);
	}

	const html = readPage(entry.page);
	if (!html) return errorResponse(`Documentation page not found: ${entry.page}`);

	const doc = formatGuideDoc(html);
	return textResponse(doc);
}

const REFERENCE = `
## Setup

### Minimal (Standalone)
\`\`\`html
<link rel="stylesheet" href="NUI/css/nui-theme.css">
<script type="module" src="NUI/nui.js"></script>
\`\`\`

### FOUC Prevention (App Mode)
\`\`\`css
body { margin: 0; overflow: hidden; }
nui-app:not(.nui-ready) { display: none; }
nui-loading:not(.active) { display: none; }
\`\`\`

### Addon Imports (optional)
| Addon | JS | CSS |
|-------|----|-----|
| nui-menu | NUI/lib/modules/nui-menu.js | NUI/css/modules/nui-menu.css |
| nui-list | NUI/lib/modules/nui-list.js | NUI/css/modules/nui-list.css |
| nui-markdown | NUI/lib/modules/nui-markdown.js | — |
| nui-syntax-highlight | NUI/lib/modules/nui-syntax-highlight.js | — |

## Root API (\`nui.*\`)

\`\`\`js
nui.init(options)                              // Auto-called; initializes library
nui.configure({ iconSpritePath, baseFontSize, animationDuration })
nui.version                                    // Library version string
nui.registerFeature(name, (container, params) => { ... })
nui.registerType(type, (element, content) => { ... })
nui.createRouter(container, { defaultPage, onNavigate })
nui.enableContentLoading({ container, navigation, basePath, defaultPage })
\`\`\`

## Components API (\`nui.components.*\`)

### Dialog (ephemeral)
\`\`\`js
await nui.components.dialog.alert(title, message, options?)
await nui.components.dialog.confirm(title, message, options?)   // returns boolean
await nui.components.dialog.prompt(title, message, { fields: [{ id, label, type?, value? }] }, options?)  // returns object | null
const { dialog, main } = await nui.components.dialog.page(title, subtitle?, { contentScroll, buttons: [{ label, type, value }] })
\`\`\`
Options: { placement: 'top'|'center'|'bottom', target: Element, modal: bool, blocking: bool, classes: string[] }

### Banner (ephemeral)
\`\`\`js
const controller = nui.components.banner.show({ content, placement: 'top'|'bottom', priority: 'info'|'alert', autoClose: ms })
nui.components.banner.hide(controller)
nui.components.banner.hideAll()
\`\`\`

### Link List (persistent)
\`\`\`js
nui.components.linkList.create(data, { mode: 'fold'|'tree' })
nui.components.linkList.setActive(selector)
nui.components.linkList.getActive()
nui.components.linkList.clearActive()
\`\`\`
Data format: [{ label, icon?, href?, items?: [...] }, { separator: true }]

### Media Player (experimental, persistent)
\`\`\`js
nui.components.mediaPlayer.create(target, { url, type: 'video'|'audio', poster?, pauseOthers?, attributes?, playerAttributes? })
\`\`\`

## Utilities (\`nui.util.*\`)

\`\`\`js
nui.util.createElement(tag, { class, attrs, data, events, content, target })
nui.util.createSvgElement(tag, attrs, children)
nui.util.enableDrag(element, { onDragStart, onDrag, onDragEnd })  // returns cleanup fn
nui.util.storage.get({ name })
nui.util.storage.set({ name, value, ttl })     // ttl: '30d', '7d', '1h'
nui.util.storage.remove({ name })
nui.util.sortByKey(array, propertyPath, numeric?)
nui.util.filter({ data, search, prop[] })
nui.util.detectEnv()                            // { isTouch, isMac, isIOS, isSafari, isFF }
nui.util.markdownToHtml(md)                     // Lightweight markdown -> HTML string
\`\`\`

## data-action Syntax

\`\`\`
data-action="name[:param][@targetSelector]"
\`\`\`
Dispatches: \`nui-action\` (generic) + \`nui-action-\${name}\` (specific), both bubble.
detail: { name, param, target, originalEvent }

## Router Contract

- Hash-based: \`#page=path/to/page\` or \`#feature=featureName\`
- Pages cached: init() runs ONCE, show()/hide() on navigation
- Scope DOM to element (page wrapper), never document

## Key Component Events

| Component | Events | Detail |
|-----------|--------|--------|
| nui-dialog | nui-dialog-open, nui-dialog-close, nui-dialog-cancel | { returnValue } |
| nui-tabs | nui-tabs-change | { tab, panel } |
| nui-select | nui-select-change | { value } |
| nui-sortable | nui-sort-reorder | { from, to } |
| nui-accordion | toggle | native |
| nui-link-list | nui-link-click | { href, label } |
`;

export async function nui_get_reference() {
	return textResponse(REFERENCE.trim());
}

export async function nui_get_css_variables() {
	const cache = ensureAssetCache();
	if (!cache.cssVars || cache.cssVars.length === 0) {
		return errorResponse('Failed to read CSS variables from nui-theme.css.');
	}

	const lines = [`## NUI CSS Variables (${cache.cssVars.length} total, commit: ${cache.commit?.substring(0, 7)})`, ''];

	const categories = {
		'Spacing': /^--nui-space|^--space-/,
		'Font': /^--font-/,
		'Text Color': /^--text-color/,
		'Color Base': /^--color-(base|contrast|white|black|highlight|accent|banner)/,
		'Color Shades': /^--color-shade\d/,
		'Border': /^--border-/,
		'Shadow': /^--shadow-/,
		'Icon': /^--icon-/,
		'Other': null
	};

	const grouped = {};
	for (const cat of Object.keys(categories)) grouped[cat] = [];

	for (const v of cache.cssVars) {
		let placed = false;
		for (const [cat, regex] of Object.entries(categories)) {
			if (regex && regex.test(v.name)) {
				grouped[cat].push(v);
				placed = true;
				break;
			}
		}
		if (!placed) grouped['Other'].push(v);
	}

	for (const [cat, vars] of Object.entries(grouped)) {
		if (vars.length === 0) continue;
		lines.push(`### ${cat}`);
		for (const v of vars) {
			lines.push(`- \`${v.name}\` → \`${v.value}\``);
		}
		lines.push('');
	}

	return textResponse(lines.join('\n'));
}

export async function nui_get_icons() {
	const cache = ensureAssetCache();
	if (!cache.icons || cache.icons.length === 0) {
		return errorResponse('Failed to read icon sprite from material-icons-sprite.svg.');
	}

	const lines = [
		`## NUI Icon Sprite (${cache.icons.length} icons, commit: ${cache.commit?.substring(0, 7)})`,
		'',
		'Usage: `<nui-icon name="ICON_NAME">fallback</nui-icon>`',
		'',
		'```text',
		cache.icons.join(', '),
		'```'
	];

	return textResponse(lines.join('\n'));
}
