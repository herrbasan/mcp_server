// Gemini API Info Test Script
// Run: node test/test-gemini-info.js
// Shows available models, context windows, quota info

import dotenv from 'dotenv';
dotenv.config();

const API_KEY = process.env.GEMINI_API_KEY;
const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

async function fetchGemini(endpoint) {
  const url = `${BASE_URL}${endpoint}?key=${API_KEY}`;
  const response = await fetch(url);
  
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`HTTP ${response.status}: ${error}`);
  }
  
  return response.json();
}

async function main() {
  console.log('='.repeat(60));
  console.log('Gemini API Information');
  console.log('='.repeat(60));
  
  if (!API_KEY) {
    console.error('❌ GEMINI_API_KEY not found in environment');
    process.exit(1);
  }
  
  console.log(`API Key: ${API_KEY.substring(0, 8)}...${API_KEY.substring(API_KEY.length - 4)}`);
  console.log();
  
  try {
    // 1. List available models
    console.log('--- Available Models ---\n');
    const modelsData = await fetchGemini('/models');
    
    if (modelsData.models) {
      // Filter for Gemini models only
      const geminiModels = modelsData.models.filter(m => 
        m.name.includes('gemini') && !m.name.includes('embedding')
      );
      
      for (const model of geminiModels) {
        const name = model.name.replace('models/', '');
        console.log(`📦 ${name}`);
        console.log(`   Display: ${model.displayName || 'N/A'}`);
        console.log(`   Version: ${model.version || 'N/A'}`);
        console.log(`   Description: ${model.description?.substring(0, 80) || 'N/A'}...`);
        
        // Extract context window if available
        const inputLimit = model.inputTokenLimit;
        const outputLimit = model.outputTokenLimit;
        if (inputLimit) {
          console.log(`   Input tokens: ${inputLimit.toLocaleString()}`);
        }
        if (outputLimit) {
          console.log(`   Output tokens: ${outputLimit.toLocaleString()}`);
        }
        
        // Supported generation methods
        if (model.supportedGenerationMethods) {
          console.log(`   Methods: ${model.supportedGenerationMethods.join(', ')}`);
        }
        
        console.log();
      }
    }
    
    // 2. Test a simple completion to verify API works
    console.log('--- API Test (gemini-1.5-flash) ---\n');
    
    const testResponse = await fetch(`${BASE_URL}/models/gemini-1.5-flash:generateContent?key=${API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [{ text: 'Say "Gemini API is working" and nothing else.' }]
        }],
        generationConfig: {
          maxOutputTokens: 50,
          temperature: 0.1
        }
      })
    });
    
    if (testResponse.ok) {
      const testData = await testResponse.json();
      const text = testData.candidates?.[0]?.content?.parts?.[0]?.text;
      console.log(`✅ API Response: "${text?.trim()}"`);
    } else {
      console.log(`❌ API Test failed: ${testResponse.status}`);
    }
    
    console.log();
    
    // 3. Try to get quota/limit info (if available)
    console.log('--- Quota Information ---\n');
    console.log('Note: Gemini API quota info is available in Google Cloud Console');
    console.log('Visit: https://console.cloud.google.com/apis/api/generativelanguage.googleapis.com/quotas');
    console.log();
    console.log('Default quotas (as of Feb 2026):');
    console.log('  - gemini-1.5-flash: 1,500 requests/minute (free tier)');
    console.log('  - gemini-1.5-pro: 1,000 requests/minute (paid tier)');
    console.log('  - gemini-1.0-pro: 60 requests/minute (free tier)');
    console.log('  - Input tokens: 4M/minute (flash), 4M/minute (pro)');
    console.log('  - Output tokens: 4M/minute');
    
  } catch (err) {
    console.error('❌ Error:', err.message);
    if (err.message.includes('API key not valid')) {
      console.error('\nThe API key appears to be invalid or expired.');
      console.error('Check your .env file and ensure GEMINI_API_KEY is set correctly.');
    }
    process.exit(1);
  }
  
  console.log('\n' + '='.repeat(60));
  console.log('Done');
  process.exit(0);
}

main().catch(err => {
  console.error('Failed:', err);
  process.exit(1);
});
