const API_BASE = window.location.origin;

let workspaces = [];
let currentWorkspace = '';

export async function init(element, nui) {
	await loadWorkspaces();
	setupEventListeners();
}

async function loadWorkspaces() {
	try {
		const res = await fetch(`${API_BASE}/api/code-search/workspaces`);
		const data = await res.json();
		console.log('Workspaces data:', data);
		workspaces = data.workspaces || [];
		console.log('Workspaces array:', workspaces);
		
		renderWorkspaces();
		populateWorkspaceSelect();
	} catch (err) {
		console.error('Failed to load workspaces:', err);
		document.getElementById('workspaces-list').innerHTML = `<p style="color: var(--nui-danger);">Error loading workspaces: ${err.message}</p>`;
	}
}

function renderWorkspaces() {
	const container = document.getElementById('workspaces-list');
	
	if (workspaces.length === 0) {
		container.innerHTML = '<p style="color: var(--nui-text-secondary);">No workspaces configured</p>';
		return;
	}
	
	container.innerHTML = workspaces.map(ws => `
		<div style="background: var(--nui-surface-variant); padding: 1rem; border-radius: var(--nui-radius-sm); border-left: 3px solid var(--nui-accent);">
			<div style="display: flex; justify-content: space-between; align-items: start;">
				<div style="flex: 1;">
					<h4 style="margin: 0 0 0.5rem 0;">${ws.name}</h4>
					<div style="font-size: 0.875rem; color: var(--nui-text-secondary); display: grid; gap: 0.25rem;">
						<div>Path: <code style="background: var(--nui-shade-2); padding: 0.1rem 0.3rem; border-radius: var(--nui-radius-sm);">${ws.path || 'N/A'}</code></div>
						<div>Files: <strong>${ws.fileCount || 0}</strong></div>
						<div>Index Status: <strong style="color: ${ws.indexed ? 'var(--nui-success)' : 'var(--nui-warning)'};">${ws.indexed ? 'Indexed' : 'Not Indexed'}</strong></div>
						${ws.lastUpdate ? `<div>Last Updated: ${new Date(ws.lastUpdate).toLocaleString()}</div>` : ''}
					</div>
				</div>
				<div style="display: flex; gap: 0.5rem;">
					<nui-button type="outline">
						<button type="button" data-action="refresh-index" data-workspace="${ws.name}">Refresh</button>
					</nui-button>
					<nui-button type="outline">
						<button type="button" data-action="view-stats" data-workspace="${ws.name}">Stats</button>
					</nui-button>
				</div>
			</div>
		</div>
	`).join('');
}

function populateWorkspaceSelect() {
	const select = document.getElementById('search-workspace');
	// Clear existing workspace options (keep the "All workspaces" option)
	while (select.options.length > 1) {
		select.remove(1);
	}
	// Add workspace options
	workspaces.forEach(ws => {
		const option = document.createElement('option');
		option.value = ws.name;
		option.textContent = ws.name;
		select.appendChild(option);
	});
	
	// Refresh the nui-select component to rebuild its UI
	const nuiSelect = document.getElementById('workspace-select');
	if (nuiSelect?.refresh) {
		nuiSelect.refresh();
		console.log('nui-select refreshed with', select.options.length - 1, 'workspaces');
	} else {
		console.warn('nui-select refresh method not available');
	}
}

function setupEventListeners() {
	// Refresh all indexes
	document.getElementById('refresh-all-btn').addEventListener('click', async () => {
		try {
			const res = await fetch(`${API_BASE}/api/code-search/refresh-all`, { method: 'POST' });
			const data = await res.json();
			alert(`Refreshed all indexes: ${JSON.stringify(data)}`);
			await loadWorkspaces();
		} catch (err) {
			alert(`Error: ${err.message}`);
		}
	});
	
	// Workspace actions (event delegation)
	document.getElementById('workspaces-list').addEventListener('click', async (e) => {
		const btn = e.target.closest('[data-action]');
		if (!btn) return;
		
		const action = btn.dataset.action;
		const workspace = btn.dataset.workspace;
		
		if (action === 'refresh-index') {
			try {
				btn.disabled = true;
				btn.textContent = 'Refreshing...';
				const res = await fetch(`${API_BASE}/api/code-search/refresh`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ space })
				});
				const data = await res.json();
				alert(`Index refreshed: ${data.filesIndexed} files`);
				await loadWorkspaces();
			} catch (err) {
				alert(`Error: ${err.message}`);
			} finally {
				btn.disabled = false;
				btn.textContent = 'Refresh';
			}
		} else if (action === 'view-stats') {
			try {
				const res = await fetch(`${API_BASE}/api/code-search/stats?space=${workspace}`);
				const data = await res.json();
				alert(`Stats for ${workspace}:\n${JSON.stringify(data, null, 2)}`);
			} catch (err) {
				alert(`Error: ${err.message}`);
			}
		}
	});
	
	// Search
	document.getElementById('search-btn').addEventListener('click', performSearch);
	document.getElementById('search-query').addEventListener('keypress', (e) => {
		if (e.key === 'Enter') performSearch();
	});
	
	// Clear results
	document.getElementById('clear-results-btn').addEventListener('click', () => {
		document.getElementById('search-results').innerHTML = '';
		document.getElementById('file-viewer-section').style.display = 'none';
	});
	
	// Close file viewer
	document.getElementById('close-file-btn').addEventListener('click', () => {
		document.getElementById('file-viewer-section').style.display = 'none';
	});
}

async function performSearch() {
	const workspace = document.getElementById('search-workspace').value;
	const searchType = document.getElementById('search-type').value;
	const query = document.getElementById('search-query').value.trim();
	
	if (!workspace) {
		alert('Please select a workspace');
		return;
	}
	
	if (!query) {
		alert('Please enter a search query');
		return;
	}
	
	const resultsContainer = document.getElementById('search-results');
	resultsContainer.innerHTML = '<p>Searching...</p>';
	
	try {
		if (workspace === '*') {
			// Search all workspaces and combine results
			const allResults = [];
			for (const ws of workspaces) {
				const res = await fetch(`${API_BASE}/api/code-search/search`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ space: ws.name, searchType, query })
				});
				const data = await res.json();
				if (data.results && data.results.length > 0) {
					allResults.push(...data.results);
				}
			}
			displayResults({ results: allResults }, searchType);
		} else {
			// Search single workspace
			const res = await fetch(`${API_BASE}/api/code-search/search`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ space, searchType, query })
			});
			const data = await res.json();
			displayResults(data, searchType);
		}
	} catch (err) {
		resultsContainer.innerHTML = `<p style="color: var(--nui-danger);">Error: ${err.message}</p>`;
	}
}

function displayResults(data, searchType) {
	const container = document.getElementById('search-results');
	
	if (!data.results || data.results.length === 0) {
		container.innerHTML = '<p style="color: var(--nui-text-secondary);">No results found</p>';
		return;
	}
	
	const html = data.results.map((result, idx) => {
		const similarity = result.similarity ? `${(result.similarity * 100).toFixed(1)}%` : '';
		const functions = result.functions ? `Functions: ${result.functions.join(', ')}` : '';
		
		return `
			<div style="background: var(--nui-surface); padding: 0.75rem; border-radius: var(--nui-radius-sm); margin-bottom: 0.5rem; border-left: 2px solid var(--nui-accent);">
				<div style="display: flex; justify-content: space-between; align-items: start;">
					<div style="flex: 1;">
						<div style="font-family: monospace; color: var(--nui-accent); margin-bottom: 0.25rem;">${result.file || result.path}</div>
						${similarity ? `<div style="font-size: 0.75rem; color: var(--nui-text-secondary);">Similarity: ${similarity}</div>` : ''}
						${functions ? `<div style="font-size: 0.75rem; color: var(--nui-text-secondary);">${functions}</div>` : ''}
						${result.snippet ? `<pre style="font-size: 0.75rem; margin-top: 0.5rem; background: var(--nui-shade-2); padding: 0.5rem; border-radius: var(--nui-radius-sm); overflow-x: auto;">${escapeHtml(result.snippet)}</pre>` : ''}
					</div>
					<nui-button type="outline">
						<button type="button" data-action="view-file" data-file="${result.file || result.path}" style="font-size: 0.75rem; padding: 0.4rem 0.75rem;">View</button>
					</nui-button>
				</div>
			</div>
		`;
	}).join('');
	
	container.innerHTML = html;
	
	// Add click handlers for view buttons
	container.querySelectorAll('[data-action="view-file"]').forEach(btn => {
		btn.addEventListener('click', () => viewFile(btn.dataset.file));
	});
}

async function viewFile(fileId) {
	const workspace = document.getElementById('search-workspace').value;
	
	try {
		const res = await fetch(`${API_BASE}/api/code-search/file`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ space, file: fileId })
		});
		
		const data = await res.json();
		
		document.getElementById('file-path').textContent = fileId;
		document.getElementById('file-content').textContent = data.content || 'No content available';
		document.getElementById('file-viewer-section').style.display = 'block';
		document.getElementById('file-viewer-section').scrollIntoView({ behavior: 'smooth' });
	} catch (err) {
		alert(`Error loading file: ${err.message}`);
	}
}

function escapeHtml(text) {
	const div = document.createElement('div');
	div.textContent = text;
	return div.innerHTML;
}

export function onShow() {
	// Reload workspaces when page is shown
	loadWorkspaces();
}
