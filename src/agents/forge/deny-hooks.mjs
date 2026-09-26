// Loader hook that refuses the process/thread modules for forged tool code.
// Registered by worker-bootstrap.js via module.register() before the tool
// source is imported. Reported as an honest tripwire, not a sandbox: it
// intercepts ESM resolution, and the CJS require() path is out of its reach.
const DENIED = new Set([
    'child_process', 'node:child_process',
    'worker_threads', 'node:worker_threads'
]);

export async function resolve(specifier, context, nextResolve) {
    if (DENIED.has(specifier)) {
        throw new Error(
            `Forged tools may not import "${specifier}". Use ctx.spawn for child ` +
            `processes — direct imports bypass process-tree teardown (ctx.spawn ` +
            `registers the PID so timeouts and forge_stop kill it). See forge_help.`
        );
    }
    return nextResolve(specifier, context);
}
