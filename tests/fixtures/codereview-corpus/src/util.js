// Clean file: pure functions, imported by api.js and store.js (fan-in 2).

// calculate the sum of values
export function sumValues(values) {
    if (!Array.isArray(values)) throw new Error('sumValues: values must be an array');
    let total = 0;
    for (const v of values) total += v;
    return total;
}

export function formatError(err) {
    if (!err) throw new Error('formatError: err is required');
    return `${err.name}: ${err.message}`;
}

export function slugify(text) {
    if (typeof text !== 'string') throw new Error(`slugify: expected string, got ${typeof text}`);
    return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
