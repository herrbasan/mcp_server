// Preflight: surface submodule drift before the server starts, so nobody has
// to "keep track" of what is checked out where. Zero network calls — compares
// the working copies against the recorded pointer hashes only.
//
// Markers (from git submodule status):
//   <space> = in sync with the recorded pointer
//   +       = checked-out commit is NEWER/different than the recorded pointer
//             → someone updated the submodule; commit the pointer bump
//   -       = submodule not initialized (fresh clone: run git submodule update --init)
//   (dirty) = uncommitted changes inside the submodule
//
// Never blocks startup — it informs, it doesn't gate. Exit 0 always.

import { execSync } from 'node:child_process';

try {
    const out = execSync('git submodule status', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const lines = out.trim().split('\n').filter(Boolean);
    if (!lines.length) {
        console.log('[submodules] none configured');
    } else {
        const drifted = lines.filter(l => /^[+-]/.test(l) || /\(dirty\)/.test(l));
        if (drifted.length) {
            console.log('[submodules] ⚠ attention needed:');
            for (const l of drifted) console.log('  ' + l.trim());
            console.log('  → sync: npm run update:submodules  |  pin a local bump: git add <submodule> && git commit');
        } else {
            console.log(`[submodules] all ${lines.length} in sync with recorded pointers`);
        }
    }
} catch {
    // Not a git repo / git missing — irrelevant for runtime, stay silent.
}
