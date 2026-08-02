// Quick functional test for src/utils/progress-reporter.js
import { createProgressReporter } from '../src/utils/progress-reporter.js';

const emitted = [];
const pr = createProgressReporter((msg, pct, total) => emitted.push({ msg, pct, total }));

// Rapid loop — throttle should collapse emissions, stay monotonic, end at 100.
for (let i = 1; i <= 100; i++) pr.step(i, 100, 'step ' + i);
pr.done('done');

console.log('emissions:', emitted.length);
console.log('pcts:', emitted.map(e => e.pct).join(','));
const monotonic = emitted.every((e, i) => i === 0 || e.pct >= emitted[i - 1].pct);
console.log('monotonic:', monotonic);
console.log('final pct 100:', emitted[emitted.length - 1].pct === 100);
console.log('final msg:', emitted[emitted.length - 1].msg);
console.log('total always 100:', emitted.every(e => e.total === 100));

// Null-safe: no progress fn should never throw.
const pr2 = createProgressReporter(null);
pr2.set('a', 5);
pr2.step(1, 2, 'b');
pr2.done('c');
console.log('null-safe OK');

// Window mapping: step(k,n,msg,start,end)
const e2 = [];
const pr3 = createProgressReporter((m, p, t) => e2.push(p), { throttleMs: 0 });
pr3.step(1, 2, 'mid', 30, 90);
console.log('window pct (expect 60):', e2[0]);

// Forced messages bypass throttle.
const pr4 = createProgressReporter((m, p) => {}, { throttleMs: 10000 });
let forcedCount = 0;
const pr5 = createProgressReporter((m, p) => { forcedCount++; }, { throttleMs: 10000 });
pr5.set('a', 5);
pr5.set('b', 10, true);
pr5.set('c', 12);
console.log('forced bypass (expect 2):', forcedCount);

if (!monotonic || emitted[emitted.length - 1].pct !== 100 || e2[0] !== 60 || forcedCount !== 2) {
    console.log('TEST FAILED');
    process.exit(1);
}
console.log('ALL TESTS PASSED');
