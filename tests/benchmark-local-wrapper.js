const LOCAL_WRAPPER_URL = 'http://localhost:4080/v1/embeddings';
const GATEWAY_HTTP_URL = 'http://localhost:3400';

const LOCAL_MODEL_PATHS = [
  'Qwen3-Embedding-4B-Q4_K_M.gguf',
  'Qwen\\Qwen3-Embedding-4B-GGUF\\Qwen3-Embedding-4B-Q4_K_M.gguf',
  'D:\\# AI Stuff\\LMStudio_Models\\Qwen\\Qwen3-Embedding-4B-GGUF\\Qwen3-Embedding-4B-Q4_K_M.gguf'
];

const PAIRS = [
  { a: 'a dog', b: 'a cat', label: 'related-animals' },
  { a: 'pizza', b: 'quantum physics', label: 'unrelated' },
  { a: 'AI', b: 'machine learning', label: 'related-tech' },
  { a: 'the dog solved puzzles', b: 'animals are smart', label: 'related-concept' }
];

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function localEmbed(texts, modelPath) {
  const res = await fetch(LOCAL_WRAPPER_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Model-Path': modelPath,
      'X-Model-Embedding': 'true',
      'X-Model-Pooling': 'mean',
      'X-Model-CtxSize': '32000',
      'X-Model-GpuLayers': '99',
      'X-Model-Mlock': 'true'
    },
    body: JSON.stringify({ input: texts, model: 'test', dimensions: 2560 })
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`local wrapper ${res.status}: ${txt.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.data.map(d => d.embedding);
}

async function openRouterEmbed(texts) {
  const res = await fetch(`${GATEWAY_HTTP_URL}/v1/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: texts, model: 'or-qwen-embed' })
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`OpenRouter ${res.status}: ${txt.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.data.map(d => d.embedding);
}

async function benchmark(label, embedFn) {
  console.log(`\n--- ${label} ---`);
  const all = PAIRS.flatMap(p => [p.a, p.b]);
  const start = Date.now();
  const vectors = await embedFn(all);
  const ms = Date.now() - start;
  for (let i = 0; i < PAIRS.length; i++) {
    const sim = cosine(vectors[i * 2], vectors[i * 2 + 1]);
    console.log(`  ${PAIRS[i].label}: ${sim.toFixed(4)}`);
  }
  console.log(`  time: ${ms}ms`);
}

async function main() {
  try {
    await benchmark('OpenRouter or-qwen-embed', openRouterEmbed);
  } catch (e) {
    console.log(`OpenRouter failed: ${e.message}`);
  }

  for (const modelPath of LOCAL_MODEL_PATHS) {
    try {
      await benchmark(`Local wrapper (${modelPath})`, (texts) => localEmbed(texts, modelPath));
    } catch (e) {
      console.log(`\nLocal wrapper (${modelPath}) failed: ${e.message}`);
    }
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
