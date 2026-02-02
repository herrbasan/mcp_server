// Test search engine adapters
import { searchGoogle } from '../src/scrapers/google-adapter.js';
import { searchDuckDuckGo } from '../src/scrapers/duckduckgo-adapter.js';
import { closeSharedPool } from '../src/scrapers/browser-pool.js';

const QUERY = process.argv[2] || 'rust async programming';

console.log('\n🔍 Testing Search Engine Adapters');
console.log(`Query: "${QUERY}"\n`);

async function main() {
  try {
    // Test Google
    console.log('📍 Testing Google adapter...');
    const googleResults = await searchGoogle(QUERY, { headless: false, devtools: true });
    console.log(`   ✅ Found ${googleResults.length} results\n`);
    googleResults.slice(0, 3).forEach((r, i) => {
      console.log(`   ${i + 1}. ${r.title}`);
      console.log(`      ${r.url.substring(0, 80)}...`);
    });
    
    console.log('\n⏳ Waiting 3s before next search...\n');
    await new Promise(r => setTimeout(r, 3000));
    
    // Test DuckDuckGo
    console.log('📍 Testing DuckDuckGo adapter...');
    const ddgResults = await searchDuckDuckGo(QUERY, { headless: false, devtools: true });
    console.log(`   ✅ Found ${ddgResults.length} results\n`);
    ddgResults.slice(0, 3).forEach((r, i) => {
      console.log(`   ${i + 1}. ${r.title}`);
      console.log(`      ${r.url.substring(0, 80)}...`);
    });
    
    console.log('\n\n✅ Tests complete!');
    console.log('   Tabs will linger 10-30s before closing');
    console.log('   Browser stays open - press Ctrl+C to exit\n');
    
    // Keep running to see lingering behavior
    await new Promise(() => {});
    
  } catch (error) {
    console.error('\n❌ Error:', error.message);
  } finally {
    await closeSharedPool();
  }
}

main();
