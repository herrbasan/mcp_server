import { nui } from './nui_wc2/NUI/nui.js';

nui.init();

const API_BASE = '';

// Memory state
let memories = [];
let currentCategory = null;

// Logs state
let logs = [];
let logsEventSource = null;

function startLogStream() {
	if (logsEventSource) {
		logsEventSource.close();
	}

	console.log('Starting SSE log stream...');
	logsEventSource = new EventSource(`${API_BASE}/api/logs/stream`);
	
	logsEventSource.onopen = () => {
		console.log('SSE connection opened');
	};
	
	logsEventSource.onmessage = (event) => {
		console.log('SSE message received:', event.data);
		const data = JSON.parse(event.data);
		
		if (data.type === 'initial') {
			console.log('Initial logs received:', data.logs.length);
			logs = data.logs;
			renderLogs();
		} else if (data.type === 'log') {
			console.log('New log received:', data.log);
			logs.unshift(data.log);
			if (logs.length > 100) logs.pop();
			renderLogs();
		}
	};
	
	logsEventSource.onerror = (error) => {
		console.error('SSE connection error:', error);
		console.error('SSE readyState:', logsEventSource?.readyState);
		setTimeout(() => startLogStream(), 5000);
	};
}

function stopLogStream() {
	if (logsEventSource) {
		logsEventSource.close();
		logsEventSource = null;
	}
}

// Navigation data
const navigationData = [
	{
		label: 'Management',
		items: [
			{ label: 'Memory Management', href: '#page=memories' },
			{ label: 'Logs Viewer', href: '#page=logs' }
		]
	}
];

// Load side navigation
const sideNav = document.querySelector('nui-side-nav nui-link-list');
if (sideNav && sideNav.loadData) {
	sideNav.loadData(navigationData);
}

// Simple manual content loader (bypassing NUI's buggy one)
async function loadPage(pageName) {
	const main = document.querySelector('nui-main');
	if (!main) return;
	
	try {
		const html = await fetch(`/pages/${pageName}.html`).then(r => r.text());
		main.innerHTML = html;
		
		// Call page init if module exists
		const module = await import(`/pages/${pageName}.js`);
		if (module.init) {
			await module.init(main, nui);
		}
	} catch (err) {
		console.error(`Failed to load page ${pageName}:`, err);
		main.innerHTML = `<p>Error loading page: ${err.message}</p>`;
	}
}

// Handle navigation
window.addEventListener('hashchange', () => {
	const hash = window.location.hash.substring(1);
	const params = new URLSearchParams(hash);
	const page = params.get('page') || 'memories';
	loadPage(page);
});

// Load initial page
const hash = window.location.hash.substring(1);
const params = new URLSearchParams(hash);
const initialPage = params.get('page') || 'memories';
loadPage(initialPage);

// Memory management functions
async function loadMemories(category = null) {
	const url = category ? `${API_BASE}/api/memory/list?category=${category}` : `${API_BASE}/api/memory/list`;
	const res = await fetch(url);
	const data = await res.json();
	memories = data.memories;
	currentCategory = category;
	filteredMemories = memories;
	applyFilters();
	
	// Setup filter listeners (only once)
	const catFilter = document.getElementById('category-filter');
	const domFilter = document.getElementById('domain-filter');
	const searchInput = document.getElementById('search-input');
	
	if (catFilter && !catFilter.dataset.hasListener) {
		catFilter.addEventListener('change', () => {
			categoryFilter = catFilter.value;
			applyFilters();
		});
		catFilter.dataset.hasListener = 'true';
	}
	
	if (domFilter && !domFilter.dataset.hasListener) {
		domFilter.addEventListener('change', () => {
			domainFilter = domFilter.value;
			applyFilters();
		});
		domFilter.dataset.hasListener = 'true';
	}
	
	if (searchInput && !searchInput.dataset.hasListener) {
		let timeout;
		searchInput.addEventListener('input', () => {
			clearTimeout(timeout);
			timeout = setTimeout(() => {
				searchTerm = searchInput.value;
				applyFilters();
			}, 300);
		});
		searchInput.dataset.hasListener = 'true';
	}
}

let filteredMemories = [];
let searchTerm = '';
let categoryFilter = '';
let domainFilter = '';

function applyFilters() {
	filteredMemories = memories.filter(m => {
		if (categoryFilter && m.category !== categoryFilter) return false;
		if (domainFilter && m.domain !== domainFilter) return false;
		if (searchTerm) {
			const search = searchTerm.toLowerCase();
			if (!m.text.toLowerCase().includes(search) && 
			    !(m.domain || '').toLowerCase().includes(search)) return false;
		}
		return true;
	});
	renderMemories();
}

function renderMemories() {
	const container = document.getElementById('memories-list');
	const countEl = document.getElementById('memory-count');
	if (!container) return;

	if (filteredMemories.length === 0) {
		container.innerHTML = '<p style="text-align: center; padding: 2rem; color: var(--nui-text-secondary);">No memories match the current filters.</p>';
		if (countEl) countEl.textContent = `0 memories`;
		return;
	}

	if (countEl) countEl.textContent = `${filteredMemories.length} of ${memories.length} memories`;

	const groupedByCategory = filteredMemories.reduce((acc, m) => {
		if (!acc[m.category]) acc[m.category] = [];
		acc[m.category].push(m);
		return acc;
	}, {});

	let html = '';
	for (const [category, items] of Object.entries(groupedByCategory)) {
		html += `<div style="margin-bottom: 2rem;">`;
		html += `<h3 style="margin-bottom: 1rem; color: var(--nui-text); border-bottom: 2px solid var(--nui-accent); padding-bottom: 0.5rem;">${category} (${items.length})</h3>`;
		html += '<div style="display: grid; gap: 0.75rem;">';
		
		for (const m of items) {
			const conf = m.confidence ?? 0.5;
			const indicator = conf >= 0.7 ? 'high' : conf >= 0.5 ? 'med' : 'low';
			const symbol = conf >= 0.7 ? '✓' : conf >= 0.5 ? '~' : '?';
			const domain = m.domain ? `<span style="background: var(--nui-accent-subtle); color: var(--nui-accent-text); padding: 0.25rem 0.5rem; border-radius: var(--nui-radius-sm); font-size: 0.75rem; font-weight: 600;">${m.domain}</span>` : '';
			
			html += `<div style="background: var(--nui-surface-variant); border-radius: var(--nui-radius-sm); padding: 1rem; border-left: 4px solid var(--nui-accent);">`;
			html += `<div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 0.75rem;">`;
			html += `<div style="flex: 1;">`;
			html += `<div style="font-size: 0.875rem; color: var(--nui-text); margin-bottom: 0.5rem;">${escapeHtml(m.text)}</div>`;
			html += `<div style="display: flex; gap: 1rem; align-items: center; font-size: 0.75rem; color: var(--nui-text-secondary);">`;
			html += `<span>ID: ${m.id}</span>`;
			html += `<span>Confidence: ${symbol} ${(conf * 100).toFixed(0)}% <span class="confidence-indicator confidence-${indicator}"></span></span>`;
			html += `<span>Observations: ${m.observations || 1}</span>`;
			html += domain;
			html += `</div></div>`;
			html += `<div><nui-button-container gap="0.25rem">`;
			html += `<nui-button type="outline"><button type="button" data-action="edit-memory" data-id="${m.id}">Edit</button></nui-button>`;
			html += `<nui-button variant="danger"><button type="button" data-action="delete-memory" data-id="${m.id}">Delete</button></nui-button>`;
			html += `</nui-button-container></div></div></div>`;
		}
		
		html += '</div></div>';
	}

	container.innerHTML = html;
	
	// Update domain filter options (populate on first render)
	const domainSelect = document.getElementById('domain-filter');
	if (domainSelect && domainSelect.options.length === 1) {
		const domains = [...new Set(memories.filter(m => m.domain).map(m => m.domain))].sort();
		domains.forEach(domain => {
			const opt = document.createElement('option');
			opt.value = domain;
			opt.textContent = domain;
			domainSelect.appendChild(opt);
		});
	}
}

async function createMemory(text, category) {
	await fetch(`${API_BASE}/api/memory/create`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ text, category })
	});
	await loadMemories(currentCategory);
}

async function updateMemory(id, text, category) {
	await fetch(`${API_BASE}/api/memory/${id}`, {
		method: 'PUT',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ text, category })
	});
	await loadMemories(currentCategory);
}

async function deleteMemory(id) {
	const confirmed = await nui.components.dialog.confirm(
		'Delete Memory',
		'Are you sure you want to delete this memory? This cannot be undone.'
	);
	
	if (confirmed) {
		await fetch(`${API_BASE}/api/memory/${id}`, { method: 'DELETE' });
		await loadMemories(currentCategory);
	}
}

// Logs functions
async function loadLogs(limit = 100, type = null) {
	const url = type ? `${API_BASE}/api/logs?limit=${limit}&type=${type}` : `${API_BASE}/api/logs?limit=${limit}`;
	const res = await fetch(url);
	const data = await res.json();
	logs = data.logs;
	renderLogs();
}

function renderLogs() {
	const container = document.getElementById('logs-list');
	if (!container) return;

	if (logs.length === 0) {
		container.innerHTML = '<p>No logs available.</p>';
		return;
	}

	let html = '';
	for (const log of logs) {
		const cssClass = log.error ? 'log-entry error' : 'log-entry';
		html += `<div class="${cssClass}">`;
		html += `<div class="log-timestamp">${new Date(log.timestamp).toLocaleString()}</div>`;
		html += `<div><strong>${log.type}</strong> → ${escapeHtml(log.tool)}</div>`;
		html += `<details style="margin-top: 0.5rem;">`;
		html += `<summary style="cursor: pointer; font-weight: bold;">Request</summary>`;
		html += `<pre style="margin: 0.5rem 0; padding: 0.5rem; background: var(--nui-color-surface); overflow-x: auto;">${escapeHtml(JSON.stringify(log.request, null, 2))}</pre>`;
		html += `</details>`;
		if (log.response) {
			html += `<details style="margin-top: 0.5rem;">`;
			html += `<summary style="cursor: pointer; font-weight: bold;">Response</summary>`;
			html += `<pre style="margin: 0.5rem 0; padding: 0.5rem; background: var(--nui-color-surface); overflow-x: auto;">${escapeHtml(JSON.stringify(log.response, null, 2))}</pre>`;
			html += `</details>`;
		}
		if (log.error) {
			html += `<div style="color: var(--nui-color-error); margin-top: 0.5rem;">`;
			html += `<strong>Error:</strong> ${escapeHtml(log.error.message)}`;
			html += `<details style="margin-top: 0.25rem;">`;
			html += `<summary style="cursor: pointer;">Stack Trace</summary>`;
			html += `<pre style="margin: 0.5rem 0; font-size: 0.75rem;">${escapeHtml(log.error.stack)}</pre>`;
			html += `</details>`;
			html += `</div>`;
		}
		html += '</div>';
	}

	container.innerHTML = html;
}

async function clearLogs() {
	const confirmed = await nui.components.dialog.confirm(
		'Clear Logs',
		'Are you sure you want to clear all logs?'
	);
	
	if (confirmed) {
		await fetch(`${API_BASE}/api/logs/clear`, { method: 'POST' });
		await loadLogs();
	}
}

// Global event delegation
document.addEventListener('click', async (e) => {
	const target = e.target.closest('[data-action]');
	if (!target) return;

	const action = target.dataset.action;

	// Memory actions
	if (action === 'filter-category') {
		const category = target.dataset.category || null;
		await loadMemories(category);
	}
	
	if (action === 'refresh-memories') {
		await loadMemories(currentCategory);
	}

	if (action === 'create-memory') {
		const result = await nui.components.dialog.prompt('Create Memory', 'Enter memory details', {
			fields: [
				{ id: 'text', label: 'Text', value: '' },
				{ id: 'category', label: 'Category', value: 'observed' }
			]
		});
		if (result) {
			await createMemory(result.text, result.category);
		}
	}

	if (action === 'edit-memory') {
		const id = parseInt(target.dataset.id);
		const memory = memories.find(m => m.id === id);
		if (!memory) return;

		const result = await nui.components.dialog.prompt('Edit Memory', 'Update memory details', {
			fields: [
				{ id: 'text', label: 'Text', value: memory.text },
				{ id: 'category', label: 'Category', value: memory.category }
			]
		});
		if (result) {
			await updateMemory(id, result.text, result.category);
		}
	}

	if (action === 'delete-memory') {
		const id = parseInt(target.dataset.id);
		await deleteMemory(id);
	}

	// Logs actions
	if (action === 'refresh-logs') {
		stopLogStream();
		startLogStream();
	}

	if (action === 'clear-logs') {
		await clearLogs();
	}

	if (action === 'toggle-auto-refresh') {
		const btn = target;
		if (logsEventSource) {
			stopLogStream();
			btn.textContent = 'Auto-Refresh: OFF';
		} else {
			startLogStream();
			btn.textContent = 'Auto-Refresh: ON';
		}
	}
});

// Utility
function escapeHtml(text) {
	const div = document.createElement('div');
	div.textContent = text;
	return div.innerHTML;
}

// Export for page modules
window.app = {
	loadMemories,
	startLogStream,
	stopLogStream,
	memories,
	logs
};
