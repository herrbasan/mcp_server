export async function init(container, nui) {
	window.app.startLogStream();
}

export function onShow(container) {
	window.app.startLogStream();
}

export function onHide(container) {
	window.app.stopLogStream();
}
