import '/nui_wc2/NUI/lib/modules/nui-list.js';

const API_BASE = window.location.origin; // Same origin (port 3010)

export async function init(element, nui) {
	// Fetch memories
	const res = await fetch(`${API_BASE}/api/memory/list`);
	const data = await res.json();
	const allMemories = data.memories;
	
	// Get unique domains for custom filter
	const domains = [...new Set(allMemories.filter(m => m.domain).map(m => m.domain))].sort();
	
	// Custom filter state
	let categoryFilter = '';
	let domainFilter = '';
	
	const list = element.querySelector('#memories-list');
	
	// Function to apply category/domain filters
	function getFilteredData() {
		return allMemories.filter(item => {
			if (categoryFilter && item.category !== categoryFilter) return false;
			if (domainFilter && item.domain !== domainFilter) return false;
			return true;
		});
	}
	
	list.loadData({
		data: getFilteredData(),
		render: (item) => {
			const conf = item.confidence ?? 0.5;
			const confColor = conf >= 0.7 ? 'var(--nui-success)' : conf >= 0.5 ? 'var(--nui-warning)' : 'var(--nui-text-tertiary)';
			const confBg = conf >= 0.7 ? 'var(--nui-success-subtle)' : conf >= 0.5 ? 'var(--nui-warning-subtle)' : 'var(--nui-shade-2)';
			const symbol = conf >= 0.7 ? '✓' : conf >= 0.5 ? '~' : '?';
			
			const domainBadge = item.domain 
				? `<span style="background: var(--nui-accent-subtle); color: var(--nui-accent); padding: 0.2rem 0.5rem; border-radius: var(--nui-radius-sm); font-size: 0.7rem; font-weight: 600; letter-spacing: 0.02em;">${item.domain}</span>` 
				: '';
			
			const categoryColors = {
				proven: { bg: 'var(--nui-success-subtle)', text: 'var(--nui-success)' },
				anti_patterns: { bg: 'var(--nui-danger-subtle)', text: 'var(--nui-danger)' },
				hypotheses: { bg: 'var(--nui-info-subtle)', text: 'var(--nui-info)' },
				context: { bg: 'var(--nui-accent-subtle)', text: 'var(--nui-accent)' },
				observed: { bg: 'var(--nui-warning-subtle)', text: 'var(--nui-warning)' }
			};
			const catStyle = categoryColors[item.category] || { bg: 'var(--nui-shade-2)', text: 'var(--nui-text-secondary)' };
			
			// Format dates
			const formatDate = (dateStr) => {
				if (!dateStr) return 'N/A';
				const d = new Date(dateStr);
				const now = new Date();
				const diffMs = now - d;
				const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
				
				if (diffDays === 0) return 'Today';
				if (diffDays === 1) return 'Yesterday';
				if (diffDays < 7) return `${diffDays}d ago`;
				if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`;
				if (diffDays < 365) return `${Math.floor(diffDays / 30)}mo ago`;
				return `${Math.floor(diffDays / 365)}y ago`;
			};
			
			const fullDateFormat = (dateStr) => {
				if (!dateStr) return 'N/A';
				return new Date(dateStr).toLocaleString();
			};
			
			// Truncate text to fit fixed height
			const displayText = item.text.length > 120 ? item.text.substring(0, 117) + '...' : item.text;
			
			return nui.util.dom.fromHTML(`
				<div class="nui-list-standard-item" style="height: 5rem; background: var(--nui-surface-variant); border-left: 3px solid ${catStyle.text}; margin-bottom: 0.5rem; border-radius: var(--nui-radius-sm);">
					<div style="display: flex; flex-direction: column; justify-content: center; padding: 0.75rem 1rem; flex: 1; overflow: hidden; gap: 0.4rem;">
						<div style="font-size: 0.875rem; color: var(--nui-text); line-height: 1.3; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;" title="${escapeHtml(item.text)}">${escapeHtml(displayText)}</div>
						<div style="display: flex; gap: 0.75rem; align-items: center; font-size: 0.7rem; color: var(--nui-text-tertiary); flex-wrap: wrap;">
							<span style="background: ${catStyle.bg}; color: ${catStyle.text}; padding: 0.15rem 0.4rem; border-radius: var(--nui-radius-sm); font-weight: 600; font-size: 0.65rem; text-transform: uppercase; letter-spacing: 0.03em;">${item.category.replace('_', ' ')}</span>
							${domainBadge}
							<span style="background: ${confBg}; color: ${confColor}; padding: 0.15rem 0.4rem; border-radius: var(--nui-radius-sm); font-weight: 600;" title="Confidence: ${(conf * 100).toFixed(0)}%">${symbol} ${(conf * 100).toFixed(0)}%</span>
							<span title="Observations">👁 ${item.observations || 1}</span>
							<span style="color: var(--nui-text-secondary);">•</span>
							<span title="Created: ${fullDateFormat(item.firstSeen)}">📅 ${formatDate(item.firstSeen)}</span>
							<span title="Modified: ${fullDateFormat(item.lastSeen)}">✏️ ${formatDate(item.lastSeen)}</span>
							<span style="margin-left: auto; font-family: monospace; opacity: 0.6;">#${item.id}</span>
						</div>
					</div>
					<div style="display: flex; align-items: center; padding-right: 0.75rem; gap: 0.25rem;">
						<nui-button type="outline"><button type="button" data-action="edit-memory" data-id="${item.id}" style="font-size: 0.75rem; padding: 0.4rem 0.75rem;">Edit</button></nui-button>
						<nui-button variant="danger"><button type="button" data-action="delete-memory" data-id="${item.id}" style="font-size: 0.75rem; padding: 0.4rem 0.75rem;">Del</button></nui-button>
					</div>
				</div>
			`);
		},
		search: [
			{ prop: 'text' },
			{ prop: 'domain' },
			{ prop: 'category' }
		],
		sort: [
			{ label: 'ID', prop: 'id', numeric: true },
			{ label: 'Category', prop: 'category' },
			{ label: 'Domain', prop: 'domain' },
			{ label: 'Confidence', prop: 'confidence', numeric: true },
			{ label: 'Uses', prop: 'observations', numeric: true },
			{ label: 'Date Created', prop: 'firstSeen', numeric: true },
			{ label: 'Date Modified', prop: 'lastSeen', numeric: true }
		],
		sort_default: 0,
		footer: {
			buttons_right: [
				{
					label: 'Create Memory',
					type: 'primary',
					fnc: () => {
						alert('Create memory dialog - TODO');
					}
				},
				{
					label: 'Refresh',
					type: 'outline',
					fnc: async () => {
						const res = await fetch(`${API_BASE}/api/memory/list`);
						const data = await res.json();
						allMemories.length = 0;
						allMemories.push(...data.memories);
						list.updateData(getFilteredData());
					}
				}
			]
		},
		events: (e) => {
			if (e.type === 'sort') {
				console.log('Sort changed:', e.index, e.direction);
			} else if (e.type === 'search_input') {
				console.log('Search:', e.value);
			}
		}
	});
}

function escapeHtml(text) {
	const div = document.createElement('div');
	div.textContent = text;
	return div.innerHTML;
}

export function onShow(container) {
	// Reload when page is shown
	const list = container.querySelector('#memories-list');
	if (list && list.update) {
		list.update(true);
	}
}

