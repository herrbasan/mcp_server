// Test glob-to-regex conversion

function _globToRegex(glob) {
  let pattern = glob
    .replace(/\./g, '\\.')
    .replace(/\*\*/g, '\x00STARSTAR\x00')  // Placeholder for **
    .replace(/\*/g, '[^/\\\\]*')            // * matches within directory (not / or \)
    .replace(/\x00STARSTAR\x00/g, '.*')    // ** matches across directories
    .replace(/\?/g, '.');
  console.log(`Glob: "${glob}" -> Regex: /${pattern}/i`);
  return new RegExp(`^${pattern}$`, 'i');
}

const tests = [
  ['*worklet*.js', 'worklet.js', true],
  ['*worklet*.js', 'my-worklet-processor.js', true],
  ['*worklet*.js', 'js/worklet.js', false],  // Should NOT match - no **
  ['**/*worklet*.js', 'js/midi/midi.worklet.js', true],
  ['**/*worklet*.js', 'bin/ffmpeg-worklet-sab.js', true],
  ['**/*.js', 'src/index.js', true],
  ['*.js', 'index.js', true],
  ['*.js', 'src/index.js', false],
];

console.log('\nRunning glob tests:\n');

let passed = 0;
let failed = 0;

tests.forEach(([glob, path, expected]) => {
  const regex = _globToRegex(glob);
  const result = regex.test(path);
  const status = result === expected ? '✓' : '✗';
  console.log(`${status} "${glob}" vs "${path}" -> ${result} (expected: ${expected})`);
  if (result === expected) passed++; else failed++;
});

console.log(`\n${passed} passed, ${failed} failed`);
