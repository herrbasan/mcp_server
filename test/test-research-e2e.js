// End-to-end test of research_topic with the updated structured output
import 'dotenv/config';
import { readFileSync } from 'fs';
import { WebResearchServer } from '../src/servers/web-research.js';
import { createRouter } from '../src/router/router.js';

const configRaw = readFileSync('./config.json', 'utf8');
const configStr = configRaw.replace(/\${(\w+)}/g, (_, key) => process.env[key] || '');
const config = JSON.parse(configStr);

const router = await createRouter(config.llm);
const research = new WebResearchServer(config.servers['web-research'], router);

console.log('=== Testing research_topic end-to-end ===\n');

// Quick research with limited pages to speed up test
const result = await research.researchTopic(
  'What is the MCP protocol for AI assistants?',
  3,  // max_pages
  ['duckduckgo'],
  null // signal
);

console.log('Result type:', result.content?.[0]?.type);
console.log('Result length:', result.content?.[0]?.text?.length, 'chars');
console.log('\n--- Preview (first 1000 chars) ---');
console.log(result.content?.[0]?.text?.substring(0, 1000));
console.log('\n=== Test complete ===');
