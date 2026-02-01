#!/usr/bin/env node

/**
 * Test: Batch embedding support in LM Studio
 * Verifies that LM Studio's /v1/embeddings endpoint accepts array input
 */

import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const LM_STUDIO_ENDPOINT = process.env.LM_STUDIO_ENDPOINT || 'http://localhost:1234';
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'text-embedding-nomic-embed-text-v1.5';

async function testSingleEmbedding() {
  console.log('Test 1: Single text embedding');
  const start = Date.now();
  
  const res = await fetch(`${LM_STUDIO_ENDPOINT}/v1/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: 'Hello world, this is a test'
    })
  });

  if (!res.ok) {
    console.error(`Failed: ${res.status} ${await res.text()}`);
    return;
  }

  const data = await res.json();
  console.log(`  Response in ${Date.now() - start}ms`);
  console.log(`  Data count: ${data.data.length}`);
  console.log(`  Vector dim: ${data.data[0].embedding.length}`);
  console.log(`  ✓ Single embedding works\n`);
}

async function testBatchEmbedding() {
  console.log('Test 2: Batch embedding (array input)');
  
  const texts = [
    'First document about JavaScript',
    'Second document about Python',
    'Third document about TypeScript',
    'Fourth document about Go programming',
    'Fifth document about Rust language'
  ];

  const start = Date.now();
  
  const res = await fetch(`${LM_STUDIO_ENDPOINT}/v1/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: texts
    })
  });

  if (!res.ok) {
    console.error(`Failed: ${res.status} ${await res.text()}`);
    return false;
  }

  const data = await res.json();
  console.log(`  Response in ${Date.now() - start}ms`);
  console.log(`  Data count: ${data.data.length}`);
  console.log(`  Expected: ${texts.length}`);
  
  if (data.data.length !== texts.length) {
    console.error('  ✗ Mismatch in count!');
    return false;
  }

  // Verify indices are correct
  for (let i = 0; i < data.data.length; i++) {
    if (data.data[i].index !== i) {
      console.error(`  ✗ Index mismatch at position ${i}`);
      return false;
    }
    console.log(`  [${i}] Vector dim: ${data.data[i].embedding.length}`);
  }

  console.log(`  ✓ Batch embedding works!\n`);
  return true;
}

async function benchmarkBatch() {
  console.log('Test 3: Benchmark batch vs sequential vs parallel');
  
  const BATCH_SIZE = 50;
  const PARALLEL_REQUESTS = 4; // Matches LM Studio Parallel setting
  const TOTAL = 200;
  
  const texts = Array.from({ length: TOTAL }, (_, i) => 
    `This is document number ${i} about programming and software development concepts including functions, classes, variables and more`
  );

  // 1. Sequential single
  console.log(`\n  1. Sequential single (${TOTAL} requests):`);
  const seqStart = Date.now();
  for (const text of texts) {
    await fetch(`${LM_STUDIO_ENDPOINT}/v1/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input: text })
    });
  }
  const seqTime = Date.now() - seqStart;
  console.log(`    Time: ${seqTime}ms (${(seqTime / TOTAL).toFixed(1)}ms/item)`);

  // 2. Single batch request
  console.log(`\n  2. Single batch request (1 request with ${TOTAL} texts):`);
  const batchStart = Date.now();
  await fetch(`${LM_STUDIO_ENDPOINT}/v1/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: texts })
  });
  const batchTime = Date.now() - batchStart;
  console.log(`    Time: ${batchTime}ms (${(batchTime / TOTAL).toFixed(1)}ms/item)`);

  // 3. Parallel batch requests
  console.log(`\n  3. Parallel batches (${PARALLEL_REQUESTS} concurrent × ${BATCH_SIZE} texts each):`);
  const chunks = [];
  for (let i = 0; i < TOTAL; i += BATCH_SIZE) {
    chunks.push(texts.slice(i, i + BATCH_SIZE));
  }
  
  const parallelStart = Date.now();
  await Promise.all(chunks.map(chunk => 
    fetch(`${LM_STUDIO_ENDPOINT}/v1/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input: chunk })
    })
  ));
  const parallelTime = Date.now() - parallelStart;
  console.log(`    Time: ${parallelTime}ms (${(parallelTime / TOTAL).toFixed(1)}ms/item)`);

  // Summary
  console.log('\n  Summary:');
  console.log(`    Sequential:      ${seqTime}ms (baseline)`);
  console.log(`    Single batch:    ${batchTime}ms (${(seqTime / batchTime).toFixed(2)}x faster)`);
  console.log(`    Parallel batch:  ${parallelTime}ms (${(seqTime / parallelTime).toFixed(2)}x faster)`);
}

async function main() {
  console.log('='.repeat(50));
  console.log('LM Studio Batch Embedding Test');
  console.log('='.repeat(50));
  console.log(`Endpoint: ${LM_STUDIO_ENDPOINT}`);
  console.log(`Model: ${EMBEDDING_MODEL}\n`);

  await testSingleEmbedding();
  const batchWorks = await testBatchEmbedding();
  
  if (batchWorks) {
    await benchmarkBatch();
  }

  console.log('\n' + '='.repeat(50));
}

main().catch(console.error);
