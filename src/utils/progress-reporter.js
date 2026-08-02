// ─────────────────────────────────────────────────────────────────────────────
// Progress reporter — one shared implementation of the ctx.progress contract.
//
// Every MCP tool handler receives context.progress(message, progress, total)
// (SSE notifications/progress, total is 100). This helper owns the parts that
// every tool would otherwise re-implement:
//   - null-safety: no progress fn (or no progressToken) → all calls no-op
//   - throttling: max ~4 emissions/sec so long loops don't flood the SSE stream
//   - monotonic clamp: percentages never go backwards
//   - step()/increment()/done() helpers for loops and phases
//
// Usage:
//   const pr = createProgressReporter(context.progress);
//   pr.set('Starting...', 5);
//   for (let i = 0; i < items.length; i++) {
//     await work(items[i]);
//     pr.step(i + 1, items.length, `Processed ${i + 1}/${items.length}`);
//   }
//   pr.done('Complete');
//
// Step ranges: step(k, n, msg, start, end) maps k/n into [start, end] of the
// total, so sub-phases can own a window: pr.step(i, n, msg, 30, 90).
// ─────────────────────────────────────────────────────────────────────────────

export function createProgressReporter(progress, opts = {}) {
    const emit = typeof progress === 'function' ? progress : null;
    const throttleMs = opts.throttleMs ?? 250;
    const total = opts.total ?? 100;

    let lastPct = 0;
    let lastEmitAt = 0;

    function send(message, pct, force = false) {
        if (!emit) return;
        const now = Date.now();
        // Always emit forced messages and the final 100%; throttle the rest.
        if (!force && pct < total && now - lastEmitAt < throttleMs) return;
        lastEmitAt = now;
        lastPct = Math.max(lastPct, Math.min(pct, total));
        emit(message, lastPct, total);
    }

    return {
        // Absolute percentage. force bypasses the throttle (phase boundaries).
        set(message, pct, force = false) {
            send(message, pct, force);
        },
        // Step k of n, mapped into [start, end] of the total range.
        step(k, n, message, start = 0, end = total) {
            if (!(n > 0)) return;
            const pct = start + Math.round((k / n) * (end - start));
            send(message, pct);
        },
        // Relative bump from the current percentage.
        increment(message, delta = 1) {
            send(message, lastPct + delta);
        },
        // Final 100% — always emitted even under throttle.
        done(message = 'Done') {
            send(message, total, true);
        },
        get pct() {
            return lastPct;
        }
    };
}
