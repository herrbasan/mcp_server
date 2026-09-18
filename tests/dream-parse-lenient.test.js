// Regression test: the 2026-09-14 dreamer output failed all repair passes
// because a memory description contained unescaped inner double quotes
// ({"error":"Not found:..."}). The original artifact (data/dream_raw_output.json)
// is mutable runtime data and was since overwritten, so the failing shape is
// embedded here. Verifies the repair chain recovers it, and that valid JSON
// still parses untouched.
import { parseJsonLenient } from '../src/agents/dreaming/index.js';

let pass = 0, fail = 0;

// 1. The failing shape — description quoting a JSON error snippet with
// unescaped inner double quotes — must now parse.
const raw = '{"meta":{"version":"3.0","dreamer_reflection":"Single pass"},"nodes":[{"id":"m1","summary":"storage read failed with {"error":"Not found: docs/foo.md"} and retried"}],"clusters":[],"bridges":[],"wildcards":[]}';
try {
    const map = parseJsonLenient(raw);
    if (map && typeof map === 'object') { console.log('PASS: 2026-09-14 artifact parses'); pass++; }
    else { console.log('FAIL: artifact returned non-object'); fail++; }
} catch (e) {
    console.log(`FAIL: artifact still throws: ${e.message.slice(0, 120)}`); fail++;
}

// 2. Valid JSON must pass through unchanged
const valid = JSON.stringify({ meta: { version: '3.0' }, nodes: [{ id: 1, summary: 'a "quoted" summary' }], clusters: [], bridges: [], wildcards: [] });
const parsed = parseJsonLenient(valid);
if (JSON.stringify(parsed) === valid) { console.log('PASS: valid JSON unchanged'); pass++; }
else { console.log('FAIL: valid JSON mutated'); fail++; }

// 3. Simple unescaped inner quotes (not key:value shaped)
const dirty = '{"a": "he said "hello" today", "b": 2}';
const r3 = parseJsonLenient(dirty);
if (r3 && r3.a === 'he said "hello" today' && r3.b === 2) { console.log('PASS: simple inner quotes escaped'); pass++; }
else { console.log('FAIL: simple inner quotes — got ' + JSON.stringify(r3)); fail++; }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
