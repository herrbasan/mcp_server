import { WebResearchServer } from './src/servers/web-research.js';

const config = {
  llmEndpoint: 'http://192.168.0.100:12345/v1/chat/completions',
  llmModel: 'nvidia/nemotron-3-nano',
  maxPages: 5,
  timeout: 120000,
  searchEngines: ['duckduckgo']
};

const server = new WebResearchServer(config);

console.log('Testing web research with limited scope...\n');

const result = await server.callTool('research_topic', {
  query: 'Puppeteer best practices for web scraping',
  max_pages: 5,
  engines: ['duckduckgo']
});

console.log('\n--- RESULT ---\n');
console.log(result.content[0].text);
