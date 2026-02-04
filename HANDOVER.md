# Session Handover - Structured Output Issue

## What We're Testing
LLM server's `query_model` tool with structured JSON output via `schema` parameter.

## Status
- ✅ Test 1: Basic query (2+2) - **WORKS**
- ❌ Test 2: Structured output with schema - **FAILS** (400 error)
- ✅ Test 3: Limited output (maxTokens) - **WORKS**

## The Problem
Test 2 fails with: `LMStudio predict failed: 400`

## What We Know Works
Direct LM Studio call succeeds:
```javascript
fetch('http://localhost:12345/v1/chat/completions', {
  body: JSON.stringify({
    model: 'qwen3-coder',
    messages: [...],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'color',
        schema: { type: 'object', properties: {...}, required: [...] }
      }
    }
  })
})
// Returns valid JSON response
```

## The Pipeline
1. **Test** sends plain schema: `{ type: 'object', properties: {...} }`
2. **llm.js** passes as `responseFormat: schema`
3. **Router** should normalize to: `{ type: 'json_schema', json_schema: { name: 'response', schema: {...} } }`
4. **Adapter** sends to LM Studio

## What We Did This Session
1. Removed `taskType` concept - now just `defaultProvider` + `embeddingProvider`
2. Archived old router (`src/llm/router.js` → `src/llm/Archive/`)
3. Migrated http-server.js to use new router (`src/router/router.js`)
4. Added schema normalization in router (wraps plain schemas in OpenAI format)
5. Added debug logging to trace the issue:
   - llm.js logs received schema
   - router logs normalized format
   - adapter logs final response_format

## Next Steps
1. Restart server and run `node test/test-mcp-llm.js`
2. Check server console for debug output - should show:
   - `[DEBUG llm.js] schema received: {...}`
   - `[DEBUG router] normalized responseFormat: {...}`
   - `[DEBUG lmstudio adapter] response_format: {...}`
3. Compare what's being sent vs the working direct call
4. **The issue is likely simple** - something in the normalization or data flow

## Test File
`test/test-mcp-llm.js` - runs 3 scenarios via MCP protocol

## Debug Logging Added
- `src/servers/llm.js` line ~27
- `src/router/router.js` line ~93
- `src/router/adapters/lmstudio.js` line ~24

Remove these console.log statements after debugging.
