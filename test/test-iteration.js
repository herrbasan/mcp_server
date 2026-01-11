import { WebResearchServer } from '../src/servers/web-research.js';

const config = {
  llmEndpoint: 'http://192.168.0.100:12345/v1/chat/completions',
  llmModel: 'nvidia/nemotron-3-nano',
  maxPages: 3,
  timeout: 120000,
  searchEngines: ['duckduckgo', 'bing']
};

const server = new WebResearchServer(config);

console.log('Testing iterative research loop with intentionally vague query...\n');
console.log('Query: "React performance"\n');
console.log('Expected: Initial synthesis should have gaps → trigger follow-up iteration\n');

const result = await server.callTool('research_topic', {
  query: 'React performance',
  max_pages: 3,
  engines: ['bing']
});

console.log('\n\n======================================');
console.log('FINAL RESULT');
console.log('======================================\n');
console.log(result.content[0].text);
