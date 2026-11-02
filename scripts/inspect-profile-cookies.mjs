// Census of a Chrome profile's cookie store: which domains hold how many
// cookies, and which of those carry a session. Reads the SQLite DB directly, so
// it works with Chrome closed and never prints values.
//
//   node scripts/inspect-profile-cookies.mjs [--profile=usage|shared]
import fs from 'fs';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { profileFromArgv } from '../src/agents/usage-monitor/profiles.js';

const { name, dir } = profileFromArgv(process.argv);
console.log(`profile: ${name} (${dir})`);

const profileDirs = fs.readdirSync(dir).filter(d => {
    const p = path.join(dir, d);
    return fs.statSync(p).isDirectory() && fs.existsSync(path.join(p, 'Network', 'Cookies'));
});
for (const pd of profileDirs) {
    const dbPath = path.join(dir, pd, 'Network', 'Cookies');
    const stat = fs.statSync(dbPath);
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
        // expires_utc is Chrome-epoch microseconds — too large for a JS number,
        // so only counts are projected.
        const rows = db.prepare(`SELECT host_key, COUNT(*) AS n
                                 FROM cookies GROUP BY host_key ORDER BY n DESC`).all();
        console.log(`\n${pd}: ${stat.size} bytes, modified ${stat.mtime.toISOString()}`);
        if (!rows.length) console.log('  (no cookies)');
        for (const r of rows) console.log(`  ${String(r.host_key).padEnd(34)} ${String(r.n).padStart(3)}`);

        // Which session cookies exist, by name — values are never read. Google's
        // SID/HSID are the decisive sign a login landed in this profile.
        const names = db.prepare(`SELECT host_key, name FROM cookies
                                  WHERE name IN ('SID','HSID','SSID','APISID','SAPISID','__Secure-1PSID',
                                                 'sessionKey','__Secure-next-auth.session-token','cf_clearance')
                                  ORDER BY host_key, name`).all();
        const byHost = new Map();
        for (const n of names) {
            if (!byHost.has(n.host_key)) byHost.set(n.host_key, []);
            byHost.get(n.host_key).push(n.name);
        }
        if (byHost.size) {
            console.log('  session cookies:');
            for (const [host, list] of byHost) console.log(`    ${host}: ${list.join(', ')}`);
        } else {
            console.log('  session cookies: none');
        }
    } finally {
        db.close();
    }
}
