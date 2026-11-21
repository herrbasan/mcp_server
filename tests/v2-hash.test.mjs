/**
 * v2-hash.js against golden vectors produced by the real nVDB Rust code
 * (src/nVDB/src/v2/schema.rs + src/nVDB/src/sync.rs, blake3 1.8.3,
 * serde_json 1.0.154). Run: node tests/v2-hash.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    ANALYZER_VERSION,
    SCHEMA_VERSION,
    blake3Hex,
    canonicalJson,
    computeContentHash,
    computeEnvelopeHash,
    documentHashes,
    indexableText,
} from '../src/agents/vdb/v2-hash.js';

const PATTERN_251 = (length) => Uint8Array.from({ length }, (_, i) => i % 251);

// Official BLAKE3 test vectors (the published values also produced by the Rust
// crate): empty string and the 1025-byte `i % 251` sequence.
test('BLAKE3 official test vectors', () => {
    assert.equal(
        blake3Hex(new Uint8Array(0)),
        'af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262'
    );
    assert.equal(
        blake3Hex(PATTERN_251(1025)),
        'd00278ae47eb27b34faecf67b4fe263f82d5412916c1ffd97c8cb7fb814b8444'
    );
    assert.equal(blake3Hex(PATTERN_251(1024)), '42214739f095a406f3fc83deb889744ac00df831c10daa55189b5d121c855af7');
});

const ASCII_VECTORS = [
    ['', 'af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262'],
    ['a', '17762fddd969a453925d65717ac3eea21320b66b54342fde15128d6caf21215f'],
    ['abc', '6437b3ac38465133ffb63b75273a8db548c558465d79db03fd359c6cd5bd9d85'],
    ['hello world', 'd74981efa70a0c880b8d8c1985d075dbcbf679b99a5f9914e5aaf96b831a9e24'],
    ['nvdb', 'e59075cb71761a2f59946afa09ea3cf4a748193d536e032bd72d27035cc40447'],
    [
        'The quick brown fox jumps over the lazy dog',
        '2f1514181aadccd913abd94cfa592701a5686ab23f8df1dff1b74710febc6d4a',
    ],
];

// Every chunk/tree boundary: single-block, block-aligned chunk, first
// multi-chunk split, 2/3/4/8-chunk trees and partial subtrees.
const PATTERN_VECTORS = [
    [0, 'af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262'],
    [1, '2d3adedff11b61f14c886e35afa036736dcd87a74d27b5c1510225d0f592e213'],
    [2, '7b7015bb92cf0b318037702a6cdd81dee41224f734684c2c122cd6359cb1ee63'],
    [3, 'e1be4d7a8ab5560aa4199eea339849ba8e293d55ca0a81006726d184519e647f'],
    [4, 'f30f5ab28fe047904037f77b6da4fea1e27241c5d132638d8bedce9d40494f32'],
    [5, 'b40b44dfd97e7a84a996a91af8b85188c66c126940ba7aad2e7ae6b385402aa2'],
    [31, 'bda80c7fe2db38be6387b35c870bd7728d67b7b6cc5eb9b0e5c7dcb21ea754c2'],
    [32, 'e528e95798037df410543d9f31e396ecdd458d71b157d6014398bae32fb56c65'],
    [33, '4f4e6c1dffd3a6c9959876d15aa96b5fb0da8632b995f6ca2e30503f2829fa29'],
    [63, 'e9bc37a594daad83be9470df7f7b3798297c3d834ce80ba85d6e207627b7db7b'],
    [64, '4eed7141ea4a5cd4b788606bd23f46e212af9cacebacdc7d1f4c6dc7f2511b98'],
    [65, 'de1e5fa0be70df6d2be8fffd0e99ceaa8eb6e8c93a63f2d8d1c30ecb6b263dee'],
    [66, '191625e0be4c2b741c2fedabf54031aaa6e1991c95acf95deca48b925110f7e4'],
    [127, 'd81293fda863f008c09e92fc382a81f5a0b4a1251cba1634016a0f86a6bd640d'],
    [128, 'f17e570564b26578c33bb7f44643f539624b05df1a76c81f30acd548c44b45ef'],
    [129, '683aaae9f3c5ba37eaaf072aed0f9e30bac0865137bae68b1fde4ca2aebdcb12'],
    [1023, '10108970eeda3eb932baac1428c7a2163b0e924c9a9e25b35bba72b28f70bd11'],
    [1024, '42214739f095a406f3fc83deb889744ac00df831c10daa55189b5d121c855af7'],
    [1025, 'd00278ae47eb27b34faecf67b4fe263f82d5412916c1ffd97c8cb7fb814b8444'],
    [1026, '689062cda96fe72f7b972a1ff187798ab1090286c49b8c76a74c32f979ed5c5c'],
    [1536, 'da40c82cbf2c3923e17cbd8d423e19ac81ffaa1a40cac486604ca6168236de1a'],
    [2047, '58830fbf51a4423c573b164471690570e544cfe793bead46225664796b4b1467'],
    [2048, 'e776b6028c7cd22a4d0ba182a8bf62205d2ef576467e838ed6f2529b85fba24a'],
    [2049, '5f4d72f40d7a5f82b15ca2b2e44b1de3c2ef86c426c95c1af0b6879522563030'],
    [2050, '22bcb0fb57afafab8a092ac853d600925c2b6564445e876d6fb1ae8fbd973b62'],
    [3071, '38955dc63aa8e2f7af9e3abf3be7435d91814bb0a511df7f0dd465dfcc6d7275'],
    [3072, 'b98cb0ff3623be03326b373de6b9095218513e64f1ee2edd2525c7ad1e5cffd2'],
    [3073, '7124b49501012f81cc7f11ca069ec9226cecb8a2c850cfe644e327d22d3e1cd3'],
    [4096, '015094013f57a5277b59d8475c0501042c0b642e531b0a1c8f58d2163229e969'],
    [5000, 'ee78d92070de3df1c57c37002abf0a6b1a6589acdeef4d8ffac7cf3d9e8f2836'],
    [5120, '9cadc15fed8b5d854562b26a9536d9707cadeda9b143978f319ab34230535833'],
    [8191, 'bae8dc916e8643c6cf024097237cde1cba35c05b5d84c02834cb6b886edb76d9'],
    [8192, 'aae792484c8efe4f19e2ca7d371d8c467ffb10748d8a5a1ae579948f718a2a63'],
    [8193, 'bab6c09cb8ce8cf459261398d2e7aef35700bf488116ceb94a36d0f5f1b7bc3b'],
    [10000, '5f81f9e4ab67627b6b036d5d4e3bc40d9d3daa6fcc2b6dd07ab2bbf0a877da54'],
    [16384, 'f875d6646de28985646f34ee13be9a576fd515f76b5b0a26bb324735041ddde4'],
    [16385, '1dabe216be2578830263b049de1639f39f05a4da616b9b78c7a5e4e41662fd1f'],
    [20000, 'dc2d2e3d3dc2da545071887b7c8b1208967d6690daef412de911c25b1afc40fd'],
];

test('BLAKE3 ascii vectors', () => {
    for (const [input, expected] of ASCII_VECTORS) {
        assert.equal(blake3Hex(new TextEncoder().encode(input)), expected, `blake3("${input}")`);
    }
});

test('BLAKE3 chunk and Merkle-tree vectors', () => {
    for (const [length, expected] of PATTERN_VECTORS) {
        assert.equal(blake3Hex(PATTERN_251(length)), expected, `blake3(pattern, ${length})`);
    }
});

test('blake3Hex rejects non-byte input', () => {
    assert.throws(() => blake3Hex('abc'), /expected a Uint8Array/);
    assert.throws(() => blake3Hex([1, 2, 3]), /expected a Uint8Array/);
});

// serde_json's rendering of the number JSON.stringify writes for each value:
// i64/u64 integers survive unchanged, everything else goes through ryu.
const NUMBER_VECTORS = [
    [0, '0'],
    [-1, '-1'],
    [17, '17'],
    [4294967295, '4294967295'],
    [9007199254740991, '9007199254740991'],
    [1000000000000000, '1000000000000000'],
    [10000000000000000, '10000000000000000'],
    [100000000000000000, '100000000000000000'],
    [1000000000000000000, '1000000000000000000'],
    [9223372036854776000, '9223372036854776000'],
    [-9223372036854776000, '-9.223372036854776e+18'],
    [100000000000000000000, '1e+20'],
    [18446744073709552000, '1.8446744073709552e+19'],
    [150000000000000000000, '1.5e+20'],
    [1e21, '1e+21'],
    [0.1, '0.1'],
    [0.5, '0.5'],
    [1.5, '1.5'],
    [0.000025, '0.000025'],
    [3.14159, '3.14159'],
    [1234.5678, '1234.5678'],
    [1e-7, '1e-7'],
    [0.000001, '1e-6'],
    [0.00001, '0.00001'],
    [0.000123, '0.000123'],
    [5e-324, '5e-324'],
    [1.7976931348623157e308, '1.7976931348623157e+308'],
    [1e300, '1e+300'],
    [-0.1, '-0.1'],
    [-1e21, '-1e+21'],
    [1.5e-10, '1.5e-10'],
    [1.2345678901234568e21, '1.2345678901234568e+21'],
    [2.2250738585072014e-308, '2.2250738585072014e-308'],
    [0.3, '0.3'],
    [0.7, '0.7'],
    [-0, '0'],
    [1e-320, '1e-320'],
    [1e-323, '1e-323'],
    [1.0000000000000002, '1.0000000000000002'],
    [2.220446049250313e-16, '2.220446049250313e-16'],
    [-0.000025, '-0.000025'],
    [1234567.8901234567, '1234567.8901234567'],
];

test('canonicalJson numbers match serde_json', () => {
    for (const [value, expected] of NUMBER_VECTORS) {
        assert.equal(canonicalJson(value), expected, `canonicalJson(${value})`);
    }
});

// V8 and ryu both emit a shortest round-tripping digit string, but not always
// the same one. Pinned so a future "fix" cannot silently change the wire form;
// metadata numbers this extreme do not occur in practice.
test('known V8/ryu digit-choice divergence', () => {
    assert.equal(canonicalJson(123456789.123456789), '123456789.12345679');
    assert.equal(canonicalJson(9.999999999999999e20), '9.999999999999999e+20');
    assert.equal(canonicalJson(1.7976931348623155e308), '1.7976931348623155e+308');
});

test('canonicalJson matches write_canonical_json', () => {
    assert.equal(canonicalJson(null), 'null');
    assert.equal(canonicalJson(true), 'true');
    assert.equal(canonicalJson(false), 'false');
    assert.equal(canonicalJson('he said "hi"\tand\\back'), '"he said \\"hi\\"\\tand\\\\back"');
    assert.equal(canonicalJson('ctl\u0000\u0001\u001f\b\f\r\n'), '"ctl\\u0000\\u0001\\u001f\\b\\f\\r\\n"');
    assert.equal(canonicalJson('Grüße 世界 𝄞'), '"Grüße 世界 𝄞"');
    assert.equal(
        canonicalJson({ zeta: 1, alpha: true, nested: { b: [1, 2, 3], a: null }, empty_obj: {}, empty_arr: [] }),
        '{"alpha":true,"empty_arr":[],"empty_obj":{},"nested":{"a":null,"b":[1,2,3]},"zeta":1}'
    );
    // Rust sorts map keys bytewise (UTF-8), i.e. by code point: 'A' < 'a' < 'ä'
    // < '𝄞', and a surrogate pair sorts after the BMP range.
    assert.equal(
        canonicalJson({ '𝄞': 'supplementary-key', ä: 'umlaut-key', a: 'lower-first', A: 'upper-first', 0: 'digit' }),
        '{"0":"digit","A":"upper-first","a":"lower-first","ä":"umlaut-key","𝄞":"supplementary-key"}'
    );
    assert.equal(canonicalJson([null, true, false, 0, -1, 17, 's', [], {}, [1, [2, [3]]]]), '[null,true,false,0,-1,17,"s",[],{},[1,[2,[3]]]]');
});

test('canonicalJson refuses values JSON cannot represent', () => {
    assert.throws(() => canonicalJson(undefined), /unsupported value/);
    assert.throws(() => canonicalJson({ a: undefined }), /unsupported value/);
    assert.throws(() => canonicalJson(Number.NaN), /non-finite/);
    assert.throws(() => canonicalJson(Number.POSITIVE_INFINITY), /non-finite/);
});

const DOCS = [
    { id: 'doc-min', kind: 'doc' },
    {
        id: 'doc-full',
        parent_id: 'root',
        chunk_index: 7,
        kind: 'doc',
        title: 'Aurora Desk',
        name: 'aurora.md',
        path: 'notes/aurora.md',
        headings: 'Aurora Desk > Intro > Details',
        categories: ['product', 'hardware'],
        tags: ['alpha', 'beta', 'gamma'],
        body: 'The quick brown fox jumps over the lazy dog.\nSecond line.',
        acl: ['ops', 'eng', 'ops'],
        metadata: {
            zeta: 1,
            alpha: true,
            nested: { b: [1, 2, 3], a: null },
            empty_obj: {},
            empty_arr: [],
            quote: 'he said "hi"\tand\\back',
            unicode: 'Grüße 世界 𝄞',
        },
    },
    {
        id: 'acl-order',
        kind: 'memory',
        acl: ['𝄞-music', 'zebra', '\ufffdz', 'eng', 'Eng', '', 'eng'],
        metadata: { k: 'v' },
    },
    { id: 'chunk-zero', parent_id: 'doc-full', chunk_index: 0, kind: 'chunk', body: 'chunk body' },
    { id: 'chunk-max', parent_id: '', chunk_index: 4294967295, kind: 'chunk', acl: [], metadata: {} },
    {
        id: 'float-meta',
        kind: 'record',
        metadata: {
            a: 0.1,
            b: 1.5,
            c: 1e21,
            d: 1e-7,
            e: 2.5e-5,
            f: 3.14159,
            g: 1234.5678,
            h: -0.1,
            i: 1e300,
            j: 2.220446049250313e-16,
        },
    },
    {
        id: 'empty-all',
        kind: '',
        title: '',
        name: '',
        path: '',
        headings: '',
        categories: [],
        tags: [],
        body: '',
        acl: [],
        metadata: {},
    },
    {
        id: 'unicode-body',
        kind: 'chat',
        title: 'Über 世界',
        body: 'emoji 🚀 and controls \u0000\u0001\u001f and \b\f\r\n\tend',
        tags: ['ä', 'ae'],
        metadata: { emoji: '🚀' },
    },
    {
        id: 'meta-arrays',
        kind: 'doc',
        metadata: {
            list: [null, true, false, 0, -1, 17, 's', [], {}, [1, [2, [3]]]],
            A: 'upper-first',
            a: 'lower-first',
            _: 'underscore',
            0: 'digit',
            ä: 'umlaut-key',
            '𝄞': 'supplementary-key',
        },
    },
    { id: 'versions', kind: 'doc', body: 'versioned', schema_version: 1, analyzer_version: 1 },
];

// Generated by the Rust implementation; `envelope_hash_v1` uses schema and
// analyzer version 1, `envelope_hash` the document's own (default 2).
const EXPECTED = [
    {
        indexable_text: '\n\n\n\n\n\n',
        content_hash: 'b26683821e0783210c9b08966407b3f00837f78750e62792d17096ab75432fc4',
        envelope_hash: 'af18d0b0f0af9b76928bec84f7a58bf10456316e706b1fb25c452ebe1d7e59b3',
        envelope_hash_v1: '51d1d447d43ab3c6fc388d2e09b5d4c97638d043f8ee252d044d9f887b33cc0c',
    },
    {
        indexable_text:
            'Aurora Desk\naurora.md\nnotes/aurora.md\nAurora Desk > Intro > Details\nproduct hardware\nalpha beta gamma\nThe quick brown fox jumps over the lazy dog.\nSecond line.',
        content_hash: '5de61eaf94a3c0aaf20583bc623be0b67bb3ff8f80fe01ee9f6ce5ba47d91ae3',
        envelope_hash: 'e674b2d4e81a27a858806ab7f2fa49d0bdb2d01416ec36807f5bc9998392a59b',
        envelope_hash_v1: '2ee600ba7c0ec8c94d6a8c12551a8c85445a801d633cb00dbd0d3fd37fcf9249',
    },
    {
        indexable_text: '\n\n\n\n\n\n',
        content_hash: 'b26683821e0783210c9b08966407b3f00837f78750e62792d17096ab75432fc4',
        envelope_hash: '338524719e02fba509371bf1838e5a064781cbb6cfad1dfaa5704148c47d70e9',
        envelope_hash_v1: 'cfca25f1f1f9feda831e7a7bf21e36032c9b8d48d20e54278cd237b29c3205b3',
    },
    {
        indexable_text: '\n\n\n\n\n\nchunk body',
        content_hash: '5ae0a73832a042c9d220231d87f391f3e7a69aa24c249f060e740221ad37bf19',
        envelope_hash: 'f5b6be1a26d3dfabe81160224110d23e973af1d7dec420fd9b190aa3de52d20b',
        envelope_hash_v1: '97b6ee21836f4c59901d47d4d8f68628a838471c7c8659ab3d0e575fa46b465e',
    },
    {
        indexable_text: '\n\n\n\n\n\n',
        content_hash: 'b26683821e0783210c9b08966407b3f00837f78750e62792d17096ab75432fc4',
        envelope_hash: '2207d06148c437e353277883fa4cdebcfddf26a75d4f857ae297eb2587c2c4f9',
        envelope_hash_v1: '9c238f6f15b0431bd4785e27c54817baf9bec054a3c9183af1d56b409bea96df',
    },
    {
        indexable_text: '\n\n\n\n\n\n',
        content_hash: 'b26683821e0783210c9b08966407b3f00837f78750e62792d17096ab75432fc4',
        envelope_hash: '117602e9f239455f345e4e157ecc01f679088e41363d9e8349bc8075e677625d',
        envelope_hash_v1: '96c81e92ceb75357fd331639f23ae65f0adfb8ab16b2a8e9f70d35f94661f5b6',
    },
    {
        indexable_text: '\n\n\n\n\n\n',
        content_hash: 'b26683821e0783210c9b08966407b3f00837f78750e62792d17096ab75432fc4',
        envelope_hash: '93cf712eebd5a33609ce654bc2c26447792380cbe1c31e2b5664a698fcf3d24a',
        envelope_hash_v1: 'd2b4f94f5181724c499858607a29a36d998969c0c2b9e542fe073808a8a11a17',
    },
    {
        indexable_text: 'Über 世界\n\n\n\n\nä ae\nemoji 🚀 and controls \u0000\u0001\u001f and \b\f\r\n\tend',
        content_hash: '22b855ebf3f807b1778c95c385d05119b5be8f707b9a231e3d2c4d2b3d693b51',
        envelope_hash: '4dc9a51b8f914d9a395bf5858e20341e2a826dafbf1c1996b4c8092e4928ced9',
        envelope_hash_v1: '02db0685c96062e5ed2d2f436183513b8916f1a6fd64c17d130eac368e0a358d',
    },
    {
        indexable_text: '\n\n\n\n\n\n',
        content_hash: 'b26683821e0783210c9b08966407b3f00837f78750e62792d17096ab75432fc4',
        envelope_hash: '31ef40d53a7b5266dcedbf35d5ce945d35d464c65a328f35d4a1d33bda1117a7',
        envelope_hash_v1: '1010f9561b591428cf079b54e16e1e34ca381ad63f1a02666a3c69ab3d8766ad',
    },
    {
        indexable_text: '\n\n\n\n\n\nversioned',
        content_hash: '7134931ae5139fb60ab6e268f7672451a0b66c23df540ec31f7874b9a1724cec',
        envelope_hash: '23b3103ce94ac3f73d4b9702380d98b4d1d5fe57131e653cb66bb2dfbbaf9364',
        envelope_hash_v1: '4ad60129647134e694436e3cb08e160b89d29341779303427081acfb8d2ff7ad',
    },
];

test('indexableText matches V2Document::indexable_text', () => {
    DOCS.forEach((doc, index) => {
        assert.equal(indexableText(doc), EXPECTED[index].indexable_text, `indexableText(${doc.id})`);
    });
});

test('content and envelope hashes match the Rust implementation', () => {
    DOCS.forEach((doc, index) => {
        const expected = EXPECTED[index];
        assert.equal(computeContentHash(indexableText(doc)), expected.content_hash, `content_hash(${doc.id})`);
        assert.equal(computeEnvelopeHash(doc), expected.envelope_hash, `envelope_hash(${doc.id})`);
        assert.equal(computeEnvelopeHash(doc, 1, 1), expected.envelope_hash_v1, `envelope_hash_v1(${doc.id})`);
        assert.deepEqual(documentHashes(doc), {
            content_hash: expected.content_hash,
            envelope_hash: expected.envelope_hash,
        }, `documentHashes(${doc.id})`);
    });
});

test('documentHashes honours the document versions like to_indexed_envelope', () => {
    // V2Document::envelope_hash() always hashes with CURRENT_*_VERSION; the
    // document's own version fields are carried by to_indexed_envelope instead.
    assert.deepEqual(documentHashes(DOCS[9]), {
        content_hash: EXPECTED[9].content_hash,
        envelope_hash: EXPECTED[9].envelope_hash,
    });
    assert.equal(documentHashes(DOCS[9], 1, 1).envelope_hash, EXPECTED[9].envelope_hash_v1);
    assert.equal(SCHEMA_VERSION, 2);
    assert.equal(ANALYZER_VERSION, 2);
});

test('envelope hash is ACL order insensitive and dedups', () => {
    const base = { id: 'doc', kind: 'doc', body: 'hello world' };
    const a = computeEnvelopeHash({ ...base, acl: ['eng', 'ops'] });
    const b = computeEnvelopeHash({ ...base, acl: ['ops', 'eng', 'ops', 'eng'] });
    assert.equal(a, b);
    assert.notEqual(a, computeEnvelopeHash({ ...base, acl: ['eng'] }));
    assert.notEqual(a, computeEnvelopeHash({ ...base, acl: [] }));
});

test('envelope hash separates absent optionals from empty values', () => {
    const base = { id: 'doc', kind: 'doc' };
    const absent = computeEnvelopeHash(base);
    assert.equal(absent, computeEnvelopeHash({ ...base, parent_id: null }));
    assert.notEqual(absent, computeEnvelopeHash({ ...base, parent_id: '' }));
    assert.notEqual(absent, computeEnvelopeHash({ ...base, chunk_index: 0 }));
    assert.notEqual(computeEnvelopeHash({ ...base, chunk_index: 0 }), computeEnvelopeHash({ ...base, chunk_index: 1 }));
});

test('content hash ignores acl, metadata and chunk position', () => {
    const base = { id: 'doc', kind: 'doc', body: 'same text' };
    const content = computeContentHash(indexableText(base));
    const envelope = computeEnvelopeHash(base);
    for (const variant of [
        { ...base, acl: ['hr'] },
        { ...base, metadata: { secret: true } },
        { ...base, chunk_index: 3, parent_id: 'p' },
    ]) {
        assert.equal(computeContentHash(indexableText(variant)), content);
        assert.notEqual(computeEnvelopeHash(variant), envelope);
    }
    // Version bumps are arguments, not document fields: same as Rust, the
    // document's own schema_version/analyzer_version never reach the hash.
    assert.equal(computeEnvelopeHash({ ...base, schema_version: 1, analyzer_version: 1 }), envelope);
    assert.notEqual(computeEnvelopeHash(base, 1, 1), envelope);
});

test('malformed documents fail loudly instead of hashing silently', () => {
    assert.throws(() => indexableText({ id: 'x', kind: 'doc', title: 5 }), /title must be a string/);
    assert.throws(() => indexableText({ id: 'x', kind: 'doc', tags: 'a,b' }), /tags must be an array/);
    assert.throws(() => indexableText({ id: 'x', kind: 'doc', tags: [1] }), /only strings/);
    assert.throws(() => indexableText(null), /expected a V2Document object/);
    assert.throws(() => computeEnvelopeHash({ kind: 'doc' }), /id is required/);
    assert.throws(() => computeEnvelopeHash({ id: 'x' }), /kind is required/);
    assert.throws(() => computeEnvelopeHash({ id: 'x', kind: 'doc', chunk_index: -1 }), /expected a u32/);
    assert.throws(() => computeEnvelopeHash({ id: 'x', kind: 'doc', chunk_index: 4294967296 }), /expected a u32/);
    assert.throws(() => computeEnvelopeHash({ id: 'x', kind: 'doc', chunk_index: 1.5 }), /expected a u32/);
    assert.throws(() => computeEnvelopeHash({ id: 'x', kind: 'doc' }, 4294967296, 2), /expected a u32/);
    assert.throws(() => computeContentHash(new Uint8Array(0)), /expected a string/);
});
