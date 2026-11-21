import test from 'node:test';
import assert from 'node:assert/strict';
import {
    classifyQueryProfile,
    resolveSearchOptions,
    describeSearchOptions,
} from '../src/agents/vdb/search-options.js';

const BASE_HYBRID = {
    enabled: true,
    adaptive: true,
    rrfK: 20,
    candidateK: 200,
    lexicalWeight: 0.3,
    vectorWeight: 1.0,
    diversityField: 'parent_id',
    maxPerDocument: 2,
};

const BASE_RERANK = {
    enabled: true,
    shortlist: 20,
    weight: 0.2,
};

test('classifyQueryProfile separates exact identifiers, mixed queries, single terms, and semantic prose', () => {
    assert.equal(classifyQueryProfile('a2e3c27').profile, 'exact-id');
    assert.equal(classifyQueryProfile('md-blocks-spec').profile, 'exact-id');
    assert.equal(classifyQueryProfile('nTeligence').profile, 'exact-id');
    assert.equal(classifyQueryProfile('Agents_Prime.md').profile, 'exact-id');
    assert.equal(classifyQueryProfile('agents.vdb.serviceUrl').profile, 'exact-id');

    assert.equal(classifyQueryProfile('commit a2e3c27').profile, 'exact-short');
    assert.equal(classifyQueryProfile('open Agents_Prime.md').profile, 'exact-short');

    const mixed = classifyQueryProfile('Wo steht im GSB Handbuch etwas über robots.txt?');
    assert.equal(mixed.profile, 'mixed-exact');
    assert.equal(mixed.lexicalWeight, 0.5);
    assert.equal(mixed.vectorWeight, 1.0);
    assert.equal(classifyQueryProfile('what changed in commit a2e3c27?').profile, 'mixed-exact');
    assert.equal(classifyQueryProfile('how does mb:columns weights work in md-blocks?').profile, 'mixed-exact');
    assert.equal(classifyQueryProfile('find "exact quoted phrase" in docs').profile, 'mixed-exact');

    assert.equal(classifyQueryProfile('Rechtsschutzversicherung').profile, 'single-term');

    assert.equal(classifyQueryProfile('Which machine hosts the new standalone vector database?').profile, 'semantic');
    assert.equal(classifyQueryProfile('Welche GPU steckt in Coolkid?').profile, 'semantic');
    assert.equal(classifyQueryProfile('AI Conciousness').profile, 'semantic');
});

test('resolveSearchOptions applies adaptive weights by default and preserves explicit overrides', () => {
    const sem = resolveSearchOptions({
        query: 'Welche GPU steckt in Coolkid?',
        hybrid: BASE_HYBRID,
        rerank: BASE_RERANK,
        rerankerAvailable: true,
        diversityField: 'parent_id',
    });
    assert.equal(sem.profile, 'semantic');
    assert.equal(sem.lexicalWeight, 0.3);
    assert.equal(sem.vectorWeight, 1.0);
    assert.equal(sem.rrfK, 20);
    assert.match(describeSearchOptions(sem), /profile=semantic/);

    const hash = resolveSearchOptions({
        query: 'a2e3c27',
        hybrid: BASE_HYBRID,
        rerank: BASE_RERANK,
        rerankerAvailable: true,
        diversityField: 'parent_id',
    });
    assert.equal(hash.profile, 'exact-id');
    assert.equal(hash.lexicalWeight, 1.0);
    assert.equal(hash.vectorWeight, 0.2);

    const explicit = resolveSearchOptions({
        query: 'Welche GPU steckt in Coolkid?',
        overrides: { lexicalWeight: 1.0, vectorWeight: 0.3, rrfK: 60 },
        hybrid: BASE_HYBRID,
        rerank: BASE_RERANK,
        rerankerAvailable: true,
        diversityField: 'parent_id',
    });
    assert.equal(explicit.profile, 'explicit');
    assert.equal(explicit.lexicalWeight, 1.0);
    assert.equal(explicit.vectorWeight, 0.3);
    assert.equal(explicit.rrfK, 60);

    const staticMode = resolveSearchOptions({
        query: 'a2e3c27',
        overrides: { adaptive: false },
        hybrid: { ...BASE_HYBRID, lexicalWeight: 0.7, vectorWeight: 0.9, rrfK: 40 },
        rerank: BASE_RERANK,
        rerankerAvailable: true,
        diversityField: 'parent_id',
    });
    assert.equal(staticMode.profile, 'static');
    assert.equal(staticMode.lexicalWeight, 0.7);
    assert.equal(staticMode.vectorWeight, 0.9);
    assert.equal(staticMode.rrfK, 40);
});

test('resolveSearchOptions rejects invalid search keys and impossible combinations', () => {
    assert.throws(() => resolveSearchOptions({
        query: 'hello',
        overrides: { bogus: true },
        hybrid: BASE_HYBRID,
        rerank: BASE_RERANK,
        rerankerAvailable: true,
        diversityField: 'parent_id',
    }), /unknown key "bogus"/);

    assert.throws(() => resolveSearchOptions({
        query: 'hello',
        overrides: { dense: false, lexical: false },
        hybrid: BASE_HYBRID,
        rerank: BASE_RERANK,
        rerankerAvailable: true,
        diversityField: 'parent_id',
    }), /cannot both be off/);
});
