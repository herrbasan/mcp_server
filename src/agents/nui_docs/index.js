import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const NUI_DIR = join(__dirname, 'nui_wc2');
const PAGES_DIR = join(NUI_DIR, 'Playground', 'pages');
const REGISTRY_PATH = join(NUI_DIR, 'docs', 'components.json');

let registry = null;

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
