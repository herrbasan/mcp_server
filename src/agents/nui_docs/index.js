/**
 * NUI MCP Server - mcp_server agent
 * 
 * This file replaces src/agents/nui_docs/index.js in the mcp_server repo.
 * It reads all data dynamically from the NUI submodule's components.json
 * instead of using hardcoded strings.
 * 
 * The standalone MCP server lives in the NUI repo at:
 *   nui_wc2/scripts/mcp-server.js
 * 
 * Copy this file to: mcp_server/src/agents/nui_docs/index.js
 */

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

// ─── Data Loading ────────────────────────────────────────────────────────────

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
	} catch {
		return null;
	}
}

function readPage(pagePath) {
	const filePath = join(PAGES_DIR, `${pagePath}.html`);
	try {
		return readFileSync(filePath, 'utf-8');
	} catch {
		return null;
	}
}

function extractLlmGuide(html) {
	const match = html.match(/<nui-markdown[^>]*id="llm-guide"[^>]*>[\s\S]*?<script type="text\/markdown">([\s\S]*?)<\/script>/);
	if (!match) return null;
	return match[1].replace(/<\\\/script>/g, '</script>').trim();
}

function extractCodeExamples(html) {
	const examples = [];
	const regex = /<script\s+type="example"\s+data-lang="(\w+)">([\s\S]*?)<\/script>/gi;
	let m;
	while ((m = regex.exec(html)) !== null) {
		examples.push({ lang: m[1], code: m[2].trim() });
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
	return text.split('\n').map(l => l.replace(/^\t+/, '').trimEnd()).join('\n').trim();
}

function formatComponentDoc(name, html) {
	const parts = [];

	const llmGuide = extractLlmGuide(html);
	if (llmGuide) parts.push('## LLM Guide\n\n' + llmGuide);

	const examples = extractCodeExamples(html);
	if (examples.length > 0) {
		parts.push('## Code Examples\n');
		for (const ex of examples) {
			parts.push(`\`\`\`${ex.lang}\n${ex.code}\n\`\`\``);
		}
	}

	const textContent = extractTextContent(html);
	if (textContent) parts.push('## Documentation\n\n' + textContent);

	return parts.join('\n\n');
}

function formatGuideDoc(html) {
	const parts = [];

	const textContent = extractTextContent(html);
	if (textContent) parts.push(textContent);

	const examples = extractCodeExamples(html);
	if (examples.length > 0) {
		parts.push('## Code Examples\n');
		for (const ex of examples) {
			parts.push(`\`\`\`${ex.lang}\n${ex.code}\n\`\`\``);
		}
	}

	return parts.join('\n\n');
}

function errorResponse(msg) {
	return { content: [{ type: 'text', text: msg }], isError: true };
}

function textResponse(text) {
	return { content: [{ type: 'text', text }] };
}

// ─── Tool Handlers ───────────────────────────────────────────────────────────

export async function nui_list_components() {
	const reg = loadRegistry();
	if (!reg) return errorResponse('Failed to load component registry.');

	const lines = [];

	if (reg.components && reg.components.length > 0) {
		lines.push('## Components');
		for (const c of reg.components) {
			lines.push(`- **${c.name}** (${c.group}) — ${c.description}`);
		}
		lines.push('');
	}

	if (reg.addons && reg.addons.length > 0) {
		lines.push('## Addons');
		for (const a of reg.addons) {
			const imports = a.imports ? ` [${a.imports.js || ''}${a.imports.css ? ', ' + a.imports.css : ''}]` : '';
			lines.push(`- **${a.name}** — ${a.description}${imports}`);
		}
		lines.push('');
	}

	if (reg.reference && reg.reference.length > 0) {
		lines.push('## Reference');
		for (const r of reg.reference) {
			lines.push(`- **${r.name}** — ${r.description}`);
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

	const allEntries = [...(reg.components || []), ...(reg.addons || [])];
	const entry = allEntries.find(c =>
		c.name.toLowerCase() === name.toLowerCase() || c.name === name
	);

	if (!entry) {
		const available = allEntries.map(c => c.name).join(', ');
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

	const entry = reg.reference?.find(g =>
		g.name.toLowerCase() === topic.toLowerCase() || g.name === topic
	);

	if (!entry) {
		const available = reg.reference?.map(g => g.name).join(', ') || 'none';
		return errorResponse(`Guide "${topic}" not found. Available: ${available}`);
	}

	const html = readPage(entry.page);
	if (!html) return errorResponse(`Documentation page not found: ${entry.page}`);

	const doc = formatGuideDoc(html);
	return textResponse(doc);
}

export async function nui_get_reference() {
	const reg = loadRegistry();
	if (!reg) return errorResponse('Failed to load component registry.');

	const lines = [];

	if (reg.setup) {
		lines.push('## Setup\n');
		if (reg.setup.minimal) {
			lines.push(`### Minimal (${reg.setup.minimal.description})`);
			lines.push('```' + (reg.setup.minimal.lang || 'html'));
			lines.push(reg.setup.minimal.code);
			lines.push('```\n');
		}
		if (reg.setup.foucPrevention) {
			lines.push(`### ${reg.setup.foucPrevention.description}`);
			lines.push('```' + (reg.setup.foucPrevention.lang || 'css'));
			lines.push(reg.setup.foucPrevention.code);
			lines.push('```\n');
		}
		if (reg.setup.addons) {
			lines.push('### Addon Imports');
			lines.push('| Addon | JS | CSS |');
			lines.push('|-------|----|-----|');
			for (const addon of reg.setup.addons) {
				lines.push(`| ${addon.name} | ${addon.js || '—'} | ${addon.css || '—'} |`);
			}
			lines.push('');
		}
	}

	if (reg.api?.root) {
		lines.push('## Root API (`nui.*`)\n```js');
		for (const item of reg.api.root) {
			lines.push(item.signature + (item.description ? ` // ${item.description}` : ''));
		}
		lines.push('```\n');
	}

	if (reg.api?.components) {
		lines.push('## Components API (`nui.components.*`)');
		for (const comp of reg.api.components) {
			lines.push(`\n### ${comp.namespace} (${comp.type}${comp.experimental ? ', experimental' : ''})`);
			if (comp.description) lines.push(comp.description);
			lines.push('```js');
			for (const method of comp.methods) {
				lines.push(method.signature + (method.async ? ' // async' : ''));
			}
			lines.push('```');
		}
		lines.push('');
	}

	if (reg.api?.utilities) {
		lines.push('## Utilities (`nui.util.*`)\n```js');
		for (const util of reg.api.utilities) {
			if (util.type === 'namespace') {
				for (const method of util.methods) {
					lines.push(method.signature + (method.note ? ` // ${method.note}` : ''));
				}
			} else {
				lines.push(util.signature);
			}
		}
		lines.push('```\n');
	}

	if (reg.patterns?.dataAction) {
		const da = reg.patterns.dataAction;
		lines.push('## data-action Syntax');
		lines.push('```');
		lines.push(da.syntax);
		lines.push('```');
		if (da.description) lines.push(da.description);
		if (da.events) lines.push(`Dispatches: \`${da.events.generic}\` (generic) + \`${da.events.specific}\` (specific)`);
		if (da.detail) lines.push(`detail: ${JSON.stringify(da.detail)}`);
		if (da.bubbles !== undefined) lines.push(`bubbles: ${da.bubbles}`);
		lines.push('');
	}

	if (reg.patterns?.router) {
		lines.push('## Router Contract');
		const router = reg.patterns.router;
		if (router.hashFormat) lines.push(`- Hash format: ${router.hashFormat.join(' or ')}`);
		if (router.caching) lines.push(`- ${router.caching}`);
		if (router.scopeRule) lines.push(`- ${router.scopeRule}`);
		lines.push('');
	}

	if (reg.events && reg.events.length > 0) {
		lines.push('## Key Component Events\n');
		lines.push('| Component | Events | Detail |');
		lines.push('|-----------|--------|--------|');
		for (const item of reg.events) {
			const events = item.events.map(e => e.name).join(', ');
			const detail = item.events[0]?.detail || item.events[0]?.note || '';
			lines.push(`| ${item.component} | ${events} | ${detail} |`);
		}
	}

	return textResponse(lines.join('\n'));
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

	return textResponse([
		`## NUI Icon Sprite (${cache.icons.length} icons, commit: ${cache.commit?.substring(0, 7)})`,
		'',
		'Usage: `<nui-icon name="ICON_NAME">fallback</nui-icon>`',
		'',
		'```text',
		cache.icons.join(', '),
		'```'
	].join('\n'));
}
