import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { WebServer } from './web/server.js';
import { MemoryServer } from './servers/memory.js';
import { LMStudioServer } from './servers/lm-studio-http.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(__dirname, '..', 'config.json'), 'utf-8'));

console.error('Initializing web interface...');

// Initialize servers
const memoryServer = new MemoryServer(config.servers['memory']);
const lmStudioServer = new LMStudioServer(config.servers['lm-studio']);

// Start web server
const webServer = new WebServer(config.web, memoryServer, lmStudioServer);
webServer.start();

console.error('✓ Web interface ready\n');
