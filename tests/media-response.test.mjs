import assert from 'node:assert/strict';
import { normalizeQueuedJob } from '../src/agents/media/index.js';

const current = normalizeQueuedJob({
    success: true,
    data: {
        jobId: 'a4b16152b47a1d29',
        processor: 'image',
        progress: 0,
        progressUrl: '/v1/jobs/a4b16152b47a1d29/progress',
        status: 'queued'
    }
});
assert.deepEqual(current, { jobId: 'a4b16152b47a1d29', pollUrl: '/v1/jobs/a4b16152b47a1d29' });
console.log('  ok  current {data:{jobId,progressUrl}} uses JSON job endpoint, not SSE progress URL');

const legacy = normalizeQueuedJob({ jobId: 'legacy', poll_url: '/v1/jobs/legacy' });
assert.deepEqual(legacy, { jobId: 'legacy', pollUrl: '/v1/jobs/legacy' });
console.log('  ok  legacy explicit poll_url remains supported');

assert.throws(() => normalizeQueuedJob({ success: true, data: { status: 'queued' } }), /missing jobId\/progressUrl/);
console.log('  ok  malformed queued response fails loudly');
console.log('\n3 passed');
