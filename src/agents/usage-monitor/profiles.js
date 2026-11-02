// Chrome profiles the usage monitor may open against. One identity per profile:
// `shared` is the browser agent's — interactive work, herrbasan@googlemail.com,
// never written by the monitor. `usage` belongs to the monitor alone and holds
// every provider session (kimi, z.ai, minimax, openai, anthropic) plus the
// Google account that owns the AI Studio project (david@raum.com). The split
// exists because the two identities have different jobs: sharing one profile
// let a scrape and an interactive session log each other out (2026-11-02).
// Defined in one place because the monitor and every maintenance script must
// agree on them.
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(here, '..', '..', '..');

export const PROFILES = {
    shared: { dir: path.join(PROJECT_ROOT, 'data', 'chrome-profile'), port: 9222, chromeProfile: 'Default' },
    usage: { dir: path.join(PROJECT_ROOT, 'data', 'chrome-profile-usage'), port: 9223, chromeProfile: 'Default' },
};

// `--profile=gemini` on the maintenance scripts; shared when omitted.
export function profileFromArgv(argv, fallback = 'shared') {
    const arg = argv.find(a => a.startsWith('--profile='));
    const name = arg ? arg.slice('--profile='.length) : fallback;
    const profile = PROFILES[name];
    if (!profile) throw new Error(`unknown Chrome profile "${name}" — use ${Object.keys(PROFILES).join(' | ')}`);
    return { name, ...profile };
}
