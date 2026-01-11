import { nui } from '../../nui_wc2/NUI/nui.js';

nui.init();

const API_BASE = '';

// Memory state
let memories = [];
let currentCategory = null;

// Logs state
let logs = [];
let logsInterval = null;

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

// Content loader and router
const contentLoader = nui.enableContentLoading({
	container: 'nui-content nui-main',
	navigation: 'nui-side-nav',
	basePath: '/web/public/pages',
	defaultPage: 'memories'
});

// Memory management functions
async function loadMemories(category = null) {
	const url = category ? `${API_BASE}/api/memory/list?category=${category}` : `${API_BASE}/api/memory/list`;
	const res = await fetch(url);
	const data = await res.json();
	memories = data.memories;
	currentCategory = category;
	renderMemories();
}

function renderMemories() {
	const container = document.getElementById('memories-list');
	if (!container) return;

	if (memories.length === 0) {
		container.innerHTML = '<p>No memories found.</p>';
		return;
	}

	const groupedByCategory = memories.reduce((acc, m) => {
		if (!acc[m.category]) acc[m.category] = [];
		acc[m.category].push(m);
		return acc;
	}, {});

	let html = '';
	for (const [category, items] of Object.entries(groupedByCategory)) {
		html += `<h3>${category} (${items.length})</h3>`;
		html += '<nui-table><table>';
		html += '<thead><tr><th>ID</th><th>Text</th><th>Confidence</th><th>Observations</th><th>Actions</th></tr></thead>';
		html += '<tbody>';
		
		for (const m of items) {
			const conf = m.confidence ?? 0.5;
			const indicator = conf >= 0.7 ? 'high' : conf >= 0.5 ? 'med' : 'low';
			const symbol = conf >= 0.7 ? '✓' : conf >= 0.5 ? '~' : '?';
			
			html += '<tr>';
			html += `<td>${m.id}</td>`;
			html += `<td>${escapeHtml(m.text)}</td>`;
			html += `<td>${symbol} ${(conf * 100).toFixed(0)}%<span class="confidence-indicator confidence-${indicator}"></span></td>`;
			html += `<td>${m.observations || 1}</td>`;
			html += `<td>
				<nui-button-container gap="0.25rem">
					<nui-button type="outline" class="icon-only">
						<button type="button" data-action="edit-memory" data-id="${m.id}">Edit</button>
					</nui-button>
					<nui-button variant="danger" class="icon-only">
						<button type="button" data-action="delete-memory" data-id="${m.id}">Delete</button>
					</nui-button>
				</nui-button-container>
			</td>`;
			html += '</tr>';
		}
		
		html += '</tbody></table></nui-table>';
	}

	container.innerHTML = html;
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
		await loadLogs();
	}

	if (action === 'clear-logs') {
		await clearLogs();
	}

	if (action === 'toggle-auto-refresh') {
		const btn = target;
		if (logsInterval) {
			clearInterval(logsInterval);
			logsInterval = null;
			btn.textContent = 'Auto-Refresh: OFF';
		} else {
			logsInterval = setInterval(() => loadLogs(), 2000);
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
	loadLogs,
	memories,
	logs
};
