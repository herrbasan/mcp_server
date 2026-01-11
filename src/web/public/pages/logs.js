export async function init(container, nui) {
	await window.app.loadLogs();
}

export function onShow(container) {
	window.app.loadLogs();
}

export function onHide(container) {
	// Stop auto-refresh when leaving page
	const btn = document.querySelector('[data-action="toggle-auto-refresh"]');
	if (btn && btn.textContent.includes('ON')) {
		btn.click();
	}
}
