// Formatter tests: thinking tag stripping and JSON extraction

import { stripThinking, extractJSON, formatOutput } from '../formatter.js';

function assert(condition, message) {
  if (!condition) {
    console.error('❌ FAILED:', message);
    process.exit(1);
  }
  console.log('✅', message);
}

console.log('='.repeat(70));
console.log('FORMATTER TESTS');
console.log('='.repeat(70));

// Test 1: Strip simple thinking tags
console.log('\nTest 1: Strip simple thinking tags');
const input1 = '<think>This is internal reasoning</think>This is the answer';
const output1 = stripThinking(input1);
assert(output1 === 'This is the answer', 'Simple thinking tag removed');

// Test 2: Strip orphan closing tags (separator style)
console.log('\nTest 2: Strip orphan closing tags');
const input2 = 'Internal thoughts here</think>This is the answer';
const output2 = stripThinking(input2);
assert(output2 === 'This is the answer', 'Orphan closing tag handled');

// Test 3: Multiple thinking blocks
console.log('\nTest 3: Multiple thinking blocks');
const input3 = '<think>First thought</think>Answer 1<think>Second thought</think>Answer 2';
const output3 = stripThinking(input3);
assert(output3 === 'Answer 1Answer 2', 'Multiple thinking blocks removed');

// Test 4: Nested/complex thinking
console.log('\nTest 4: Custom tag names');
const input4 = '<analysis>Deep analysis</analysis>The result';
const output4 = stripThinking(input4, ['analysis']);
assert(output4 === 'The result', 'Custom tag name works');

// Test 5: No thinking tags
console.log('\nTest 5: No thinking tags');
const input5 = 'Just plain text';
const output5 = stripThinking(input5);
assert(output5 === 'Just plain text', 'Text without tags unchanged');

// Test 6: Extract valid JSON
console.log('\nTest 6: Extract valid JSON');
const json1 = extractJSON('{"key": "value"}');
assert(json1 && json1.key === 'value', 'Direct JSON parsing works');

// Test 7: Extract JSON from mixed text
console.log('\nTest 7: Extract JSON from mixed text');
const json2 = extractJSON('Some text before {"result": 42} and after');
assert(json2 && json2.result === 42, 'JSON extracted from mixed text');

// Test 8: Extract JSON with thinking tags
console.log('\nTest 8: Extract JSON with thinking tags');
const json3 = extractJSON('<think>reasoning</think>{"answer": "yes"}');
assert(json3 && json3.answer === 'yes', 'JSON extracted with thinking tags present');

// Test 9: Invalid JSON returns null
console.log('\nTest 9: Invalid JSON returns null');
const json4 = extractJSON('Not valid JSON at all');
assert(json4 === null, 'Invalid JSON returns null');

// Test 10: formatOutput with stripThinking
console.log('\nTest 10: formatOutput with stripThinking');
const formatted1 = formatOutput('<think>thoughts</think>Answer', { stripThinking: true });
assert(formatted1 === 'Answer', 'formatOutput strips thinking');

// Test 11: formatOutput with extractJSON
console.log('\nTest 11: formatOutput with extractJSON');
const formatted2 = formatOutput('Text {"x": 1} more', { extractJSON: true });
const parsed = JSON.parse(formatted2);
assert(parsed.x === 1, 'formatOutput extracts JSON');

// Test 12: formatOutput with both options
console.log('\nTest 12: formatOutput with both options');
const formatted3 = formatOutput('<think>logic</think>{"result": "ok"}', { 
  stripThinking: true, 
  extractJSON: true 
});
const parsed2 = JSON.parse(formatted3);
assert(parsed2.result === 'ok', 'formatOutput handles both options');

console.log('\n' + '='.repeat(70));
console.log('✅ ALL FORMATTER TESTS PASSED');
console.log('='.repeat(70));
