/**
 * Shared parameter validation for tool handlers.
 *
 * Fails loud at the boundary — before any work is done — so missing or
 * invalid parameters produce a diagnostic error instead of propagating
 * `undefined` downstream where it surfaces wearing the wrong costume
 * (e.g. "Memory #undefined not found" instead of "id is required").
 *
 * Usage:
 *   requireFields(args, ['id'], 'memory.update');
 *   requireFields(args, ['owner', 'repo', 'title'], 'git.issue_create');
 */

/**
 * Validate that the given required fields are present and non-null in args.
 * Throws on the first missing field with a message naming the tool, the
 * missing field, and the keys that *were* received — so the caller (LLM
 * or human) can immediately see what went wrong.
 *
 * @param {Object} args - The arguments object received by the tool handler.
 * @param {string[]} fields - Required field names.
 * @param {string} toolName - Tool name for the error message.
 * @throws {Error} If any required field is missing or null.
 */
export function requireFields(args, fields, toolName) {
    if (!args || typeof args !== 'object') {
        throw new Error(`${toolName}: arguments object required (received: ${typeof args})`);
    }
    const received = Object.keys(args);
    for (const field of fields) {
        if (args[field] === undefined || args[field] === null) {
            throw new Error(
                `${toolName}: missing required field "${field}" (received keys: [${received.join(', ')}])`
            );
        }
    }
}

/**
 * Validate that a value is a finite positive number (typically an ID).
 * Returns the parsed number, or throws with a diagnostic message.
 *
 * @param {*} value - The raw value (may be string, number, etc.)
 * @param {string} fieldName - Field name for the error message.
 * @param {string} toolName - Tool name for the error message.
 * @returns {number} The parsed integer ID.
 * @throws {Error} If the value cannot be parsed to a finite positive integer.
 */
export function requireId(value, fieldName, toolName) {
    if (value === undefined || value === null) {
        throw new Error(`${toolName}: missing required field "${fieldName}"`);
    }
    const parsed = typeof value === 'number'
        ? value
        : parseInt(String(value).replace(/^#/, ''), 10);
    if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error(
            `${toolName}: field "${fieldName}" must be a non-negative integer (received: ${JSON.stringify(value)})`
        );
    }
    return parsed;
}
