export async function init(container, nui) {
	await window.app.loadMemories();
}

export function onShow(container) {
	// Reload when page is shown
	window.app.loadMemories();
}
