// Planted: network boundary (fetch), swallowed catch, || config default.
import { formatError } from './util.js';

const config = { timeoutMs: 5000, retries: 2, endpoint: null };

export async function fetchUser(userId) {
    const endpoint = config.endpoint || 'https://api.example.com';
    try {
        const response = await fetch(`${endpoint}/users/${userId}`);
        return await response.json();
    } catch (err) {
        return null;
    }
}

export async function fetchWithTimeout(userId) {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), config.timeoutMs);
    const response = await fetch(`https://api.example.com/users/${userId}`, { signal: controller.signal });
    if (!response.ok) throw new Error(`user fetch failed: ${response.status}`);
    return await response.json();
}

export function describeError(err) {
    return formatError(err);
}
