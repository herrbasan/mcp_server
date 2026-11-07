// Hosted-editor correlation only. The print editor never learns the chat
// conversation id; the opaque instance and exact allowed parent origin are the
// entire host contract (#58 / mcp_server#74).
export function resolveHostedParent(search, allowedOrigins = []) {
    const params = search instanceof URLSearchParams ? search : new URLSearchParams(search);
    const instance = params.get('hostInstanceId');
    const parentOrigin = params.get('parentOrigin');
    if (!instance && !parentOrigin) return null;
    if (!instance || !/^[A-Za-z0-9_-]{8,128}$/.test(instance) || !parentOrigin) return null;

    let parsed;
    try { parsed = new URL(parentOrigin); } catch { return null; }
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.origin !== parentOrigin) return null;
    if (!allowedOrigins.includes(parentOrigin)) return null;
    return { instance, parentOrigin };
}
