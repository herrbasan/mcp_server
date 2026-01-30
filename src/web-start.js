import { config as loadDotEnv } from 'dotenv';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { WebServer } from './web/server.js';
import { MemoryServer } from './servers/memory.js';
import { LMStudioWSServer } from './servers/lm-studio-ws.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
loadDotEnv({ path: join(__dirname, '..', '.env') });
const config = JSON.parse(readFileSync(join(__dirname, '..', 'config.json'), 'utf-8'));

// Override config with environment variables if present
if (process.env.LM_STUDIO_ENDPOINT) config.servers['lm-studio'].endpoint = process.env.LM_STUDIO_ENDPOINT;
if (process.env.LM_STUDIO_MODEL) config.servers['lm-studio'].model = process.env.LM_STUDIO_MODEL;
if (process.env.LM_STUDIO_ENDPOINT) {
  const baseUrl = process.env.LM_STUDIO_ENDPOINT;
  config.servers['web-research'].llmEndpoint = `${baseUrl}/v1/chat/completions`;
  config.servers['memory'].embeddingEndpoint = `${baseUrl}/v1/embeddings`;
}
if (process.env.LM_STUDIO_MODEL) config.servers['web-research'].llmModel = process.env.LM_STUDIO_MODEL;
if (process.env.EMBEDDING_MODEL) config.servers['memory'].embeddingModel = process.env.EMBEDDING_MODEL;

// Override web config with environment variables
if (process.env.WEB_ENABLED !== undefined) config.web.enabled = process.env.WEB_ENABLED === 'true';
if (process.env.WEB_HOST) config.web.host = process.env.WEB_HOST;
if (process.env.WEB_PORT) config.web.port = parseInt(process.env.WEB_PORT);
if (process.env.WEB_MAX_LOGS) config.web.maxLogs = parseInt(process.env.WEB_MAX_LOGS);

console.error('Initializing web interface...');

// Initialize servers
const memoryServer = new MemoryServer(config.servers['memory']);
const lmStudioServer = new LMStudioWSServer(config.servers['lm-studio']);

// Start web server
const webServer = new WebServer(config.web, memoryServer, lmStudioServer);
webServer.start();

console.error('✓ Web interface ready\n');
