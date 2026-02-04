import 'dotenv/config';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const MCP_ENDPOINT = process.env.MCP_ENDPOINT || 'http://localhost:3100/mcp';

async function run(query, max_pages = 3, engines = ['duckduckgo']) {
  const client = new Client({ name: 'research-client', version: '1.0.0' }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(MCP_ENDPOINT));
  await client.connect(transport);

  console.log(`Connected to MCP at ${MCP_ENDPOINT}`);
  console.log(`Sending research_topic query: "${query}"`);

  try {
    const result = await client.callTool({
      name: 'research_topic',
      arguments: {
        query,
        max_pages,
        engines
      }
    });

    if (result?.content && result.content.length > 0) {
      console.log('\n--- MCP Result ---\n');
      console.log(result.content[0].text.substring(0, 2000));
      console.log('\n--- End Result Preview ---\n');
    } else {
      console.log('No content returned from research_topic');
    }
  } catch (err) {
    console.error('Error calling research_topic:', err.message || err);
  } finally {
    await client.close();
  }
}

// Run when invoked from CLI
if (process.argv.length >= 3) {
  const q = process.argv.slice(2).join(' ');
  run(q).catch(err => { console.error(err); process.exit(1); });
} else {
  console.log('Usage: node test/run-research-client.js "your research query"');
}
