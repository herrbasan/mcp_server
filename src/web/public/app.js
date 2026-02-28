import { nui } from './nui_wc2/NUI/nui.js';

// Import NUI components
import './nui_wc2/NUI/lib/modules/nui-list.js';

nui.init();

// Navigation data
const navigationData = [
	{
		label: 'Management',
		items: [
			{ label: 'Memory Management', href: '#page=memories' },
			{ label: 'Logs Viewer', href: '#page=logs' }
		]
	},
	{
		label: 'Codebase Indexing',
		items: [
			{ label: 'Codebases', href: '#page=codebases-list' },
			{ label: 'Configuration', href: '#page=codebases-config' },
			{ label: 'Maintenance', href: '#page=codebases-maintenance' }
		]
	}
];

// Load side navigation
const sideNav = document.querySelector('nui-side-nav nui-link-list');
if (sideNav && sideNav.loadData) {
	sideNav.loadData(navigationData);
}

// Setup content loading using NUI router
nui.enableContentLoading({
	container: 'nui-main',
	navigation: 'nui-side-nav',
	basePath: 'pages',
	defaultPage: 'memories'
});

// Global event delegation for header actions
document.addEventListener('click', async (e) => {
	const target = e.target.closest('[data-action]');
	if (!target) return;

	const action = target.dataset.action;

	// Header actions
	if (action === 'toggle-sidebar') {
		const app = document.querySelector('nui-app');
		if (app?.toggleSideNav) {
			app.toggleSideNav();
		}
	}

	if (action === 'toggle-theme') {
		const current = document.documentElement.style.colorScheme || 'light';
		const newTheme = current === 'dark' ? 'light' : 'dark';
		document.documentElement.style.colorScheme = newTheme;
		localStorage.setItem('nui-theme', newTheme);
	}
});

// Restore theme preference on load
const savedTheme = localStorage.getItem('nui-theme');
if (savedTheme) {
	document.documentElement.style.colorScheme = savedTheme;
}
