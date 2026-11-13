// Planted: process boundary (child_process), empty catch body.
import { execFile } from 'child_process';

export function gitRevision(callback) {
    execFile('git', ['rev-parse', 'HEAD'], (err, stdout) => {
        if (err) {
        }
        callback(stdout.trim());
    });
}

export function runTool(args) {
    if (!Array.isArray(args)) throw new Error(`runTool: args must be an array`);
    const child = execFile('tool', args);
    child.on('error', (err) => { throw err; });
    return child;
}
