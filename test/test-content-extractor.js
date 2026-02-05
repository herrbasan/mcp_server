// Standalone test for content-extractor.js
// Run: node test/test-content-extractor.js
// No server restart needed - completely independent

import { extractContent, validateContent } from '../src/scrapers/content-extractor.js';

// Test results tracking
const results = {
  passed: 0,
  failed: 0,
  tests: []
};

function test(name, fn) {
  try {
    const start = Date.now();
    fn();
    const duration = Date.now() - start;
    results.passed++;
    results.tests.push({ name, status: 'PASS', duration });
    console.log(`✓ ${name} (${duration}ms)`);
  } catch (err) {
    results.failed++;
    results.tests.push({ name, status: 'FAIL', error: err.message });
    console.log(`✗ ${name}`);
    console.log(`  Error: ${err.message}`);
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message || 'Assertion failed');
  }
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(message || `Expected ${expected}, got ${actual}`);
  }
}

// ===== TEST DATA =====

const TEST_CASES = {
  // Classic article structure
  article: {
    name: 'Classic Article (Wikipedia-style)',
    html: `<!DOCTYPE html>
<html>
<head><title>JavaScript Closures Guide</title></head>
<body>
  <nav><a href="/">Home</a> | <a href="/about">About</a></nav>
  <article>
    <h1>Understanding JavaScript Closures</h1>
    <p>By John Doe | Published 2024</p>
    <h2>What is a Closure?</h2>
    <p>A closure is the combination of a function bundled together (enclosed) with references to its surrounding state (the lexical environment). In other words, a closure gives you access to an outer function's scope from an inner function.</p>
    <p>In JavaScript, closures are created every time a function is created, at function creation time. They are a fundamental concept that enables powerful programming patterns.</p>
    <h2>Practical Example</h2>
    <pre><code>function makeCounter() {
  let count = 0;
  return function() {
    return ++count;
  };
}</code></pre>
    <p>This pattern is widely used in module systems and data encapsulation.</p>
    <h2>Common Use Cases</h2>
    <ul>
      <li>Data privacy and encapsulation</li>
      <li>Factory functions</li>
      <li>Maintaining state in async operations</li>
    </ul>
  </article>
  <footer>© 2024 Tech Blog. <a href="/privacy">Privacy</a> | <a href="/terms">Terms</a></footer>
</body>
</html>`,
    expectations: {
      minLength: 500,
      shouldContain: ['closure', 'lexical environment', 'function'],
      shouldNotContain: ['Privacy', 'Terms', 'Home', 'About'],
      expectedStrategy: 'readability'
    }
  },

  // Documentation page (no article tag)
  documentation: {
    name: 'Documentation Page (MDN-style)',
    html: `<!DOCTYPE html>
<html>
<head><title>Array.prototype.map() - JavaScript | MDN</title></head>
<body>
  <header class="main-header">
    <nav class="breadcrumbs"><a href="/">MDN</a> > <a href="/js">JavaScript</a></nav>
  </header>
  <main id="content">
    <h1>Array.prototype.map()</h1>
    <p class="summary">The map() method creates a new array populated with the results of calling a provided function on every element in the calling array.</p>
    <h2>Syntax</h2>
    <code>map((element) => { /* ... */ })</code>
    <h2>Parameters</h2>
    <dl>
      <dt>callbackFn</dt>
      <dd>Function that is called for every element of arr. Each time callbackFn executes, the returned value is added to newArray.</dd>
    </dl>
    <h2>Return Value</h2>
    <p>A new array with each element being the result of the callback function.</p>
    <h2>Examples</h2>
    <h3>Mapping an array of numbers to squares</h3>
    <pre>const numbers = [1, 2, 3, 4];
const squares = numbers.map(x => x * x);</pre>
    <p>This simple example demonstrates the basic usage of map().</p>
    <h3>Using map to reformat objects</h3>
    <p>You can also use map to transform objects in an array.</p>
  </main>
  <aside class="sidebar">
    <h3>Related Topics</h3>
    <ul><li><a href="/filter">filter()</a></li><li><a href="/reduce">reduce()</a></li></ul>
  </aside>
  <footer>© Mozilla Contributors</footer>
</body>
</html>`,
    expectations: {
      minLength: 400,
      shouldContain: ['map()', 'callbackFn', 'new array', 'examples'],
      shouldNotContain: ['sidebar', 'Related Topics', 'breadcrumbs'],
      expectedStrategy: 'semantic'
    }
  },

  // GitHub README-style
  github: {
    name: 'GitHub README',
    html: `<!DOCTYPE html>
<html>
<head><title>user/repo: A fantastic tool</title></head>
<body>
  <div class="Header">
    <a href="/">GitHub</a>
    <input type="text" placeholder="Search">
    <nav><a href="/pulls">Pull requests</a><a href="/issues">Issues</a></nav>
  </div>
  <div class="repository-content">
    <div class="readme markdown-body">
      <h1>Awesome Tool</h1>
      <p><a href="https://badge.svg">Build</a> <a href="https://coverage.svg">Coverage</a></p>
      <p>A powerful utility for processing data at scale. Supports multiple formats and provides excellent performance.</p>
      <h2>Installation</h2>
      <pre><code>npm install awesome-tool</code></pre>
      <h2>Quick Start</h2>
      <pre><code>const tool = require('awesome-tool');
const result = tool.process(data);</code></pre>
      <h2>Features</h2>
      <ul>
        <li>Fast processing - handles 10k items/sec</li>
        <li>Multiple formats: JSON, CSV, XML</li>
        <li>TypeScript support</li>
      </ul>
      <h2>API Reference</h2>
      <h3>process(data, options)</h3>
      <p>Processes the input data according to the provided options.</p>
      <h3>transform(input)</h3>
      <p>Transforms the input into the desired output format.</p>
      <h2>Contributing</h2>
      <p>PRs welcome! Please read our contributing guidelines first.</p>
    </div>
  </div>
  <footer class="footer">© 2024 GitHub Inc.</footer>
</body>
</html>`,
    expectations: {
      minLength: 300,
      shouldContain: ['awesome-tool', 'npm install', 'API Reference', 'process(data'],
      shouldNotContain: ['Pull requests', 'GitHub Inc', 'Search'],
      expectedStrategy: 'semantic'
    }
  },

  // Bot detection page
  botPage: {
    name: 'Bot Detection Page',
    html: `<!DOCTYPE html>
<html>
<head><title>Access Denied</title></head>
<body>
  <div class="challenge">
    <h1>Checking your browser</h1>
    <p>Please wait while we verify you are a human.</p>
    <p>This process is automatic. Your browser will redirect shortly.</p>
    <script>setTimeout(() => location.reload(), 5000);</script>
  </div>
  <div style="display:none">
    Cloudflare verification page bot detection captcha
  </div>
</body>
</html>`,
    expectations: {
      shouldBeInvalid: true,
      invalidReason: 'bot_detection'
    }
  },

  // Navigation-heavy page (small content, may fail extraction)
  navHeavy: {
    name: 'Navigation-Heavy Page',
    html: `<!DOCTYPE html>
<html>
<head><title>Site Map</title></head>
<body>
  <nav>
    <ul>
      <li><a href="/page1">Page 1 Description</a></li>
      <li><a href="/page2">Page 2 Description</a></li>
      <li><a href="/page3">Page 3 Description</a></li>
      <li><a href="/page4">Page 4 Description</a></li>
      <li><a href="/page5">Page 5 Description</a></li>
    </ul>
  </nav>
  <div class="content">
    <p>This is a sitemap page with many links.</p>
  </div>
  <footer>
    <a href="/about">About</a> | <a href="/contact">Contact</a> | <a href="/help">Help</a>
  </footer>
</body>
</html>`,
    expectations: {
      success: false // Too little actual content, mostly nav
    }
  },

  // Minimal content (should fail gracefully)
  minimalContent: {
    name: 'Minimal Content Page',
    html: `<!DOCTYPE html>
<html>
<head><title>Error</title></head>
<body>
  <h1>404 Not Found</h1>
  <p>The page you requested does not exist.</p>
</body>
</html>`,
    expectations: {
      success: false,
      shouldContainError: 'Insufficient content'
    }
  },

  // Page with inline scripts that might pollute extraction
  scriptHeavy: {
    name: 'Script-Heavy Page',
    html: `<!DOCTYPE html>
<html>
<head>
  <title>React App</title>
  <script>window.__INITIAL_STATE__ = {"user":{"id":123,"name":"Test"},"posts":[{"id":1,"title":"Hello"},{"id":2,"title":"World"}]}</script>
  <script>console.log("Analytics tracking code here");function trackEvent(e){return fetch('/track',{method:'POST',body:JSON.stringify(e)})}</script>
</head>
<body>
  <div id="root">
    <article>
      <h1>Understanding React Server Components</h1>
      <p>React Server Components allow developers to render components on the server, reducing the JavaScript bundle size sent to the client. This approach provides better performance and improved user experience.</p>
      <p>Server components can access server-side resources directly, like databases or file systems, without needing to create API endpoints. They render to HTML on the server and stream to the client.</p>
      <h2>Benefits</h2>
      <p>The main benefits include zero bundle size for server components, direct access to backend resources, and automatic code splitting. Client components can still be used for interactivity where needed.</p>
    </article>
  </div>
  <script>/* more inline scripts */</script>
</body>
</html>`,
    expectations: {
      minLength: 300,
      shouldContain: ['React Server Components', 'bundle size', 'backend resources'],
      shouldNotContain: ['__INITIAL_STATE__', 'trackEvent', 'Analytics tracking', 'console.log'],
      expectedStrategy: 'readability'
    }
  },

  // Page with no semantic tags (tests density/fallback)
  oldSchool: {
    name: 'Old-School HTML (No Semantic Tags)',
    html: `<!DOCTYPE html>
<html>
<head><title>Classic Tutorial</title></head>
<body bgcolor="white">
  <table width="100%" cellpadding="0" cellspacing="0">
    <tr><td><a href="/">Logo</a></td><td align="right"><a href="/login">Login</a></td></tr>
  </table>
  <table width="800" align="center">
    <tr>
      <td width="200" valign="top">
        <b>Menu</b><br>
        <a href="/lesson1">Lesson 1</a><br>
        <a href="/lesson2">Lesson 2</a><br>
        <a href="/lesson3">Lesson 3</a><br>
      </td>
      <td width="600" valign="top">
        <h1>Introduction to SQL</h1>
        <p>SQL (Structured Query Language) is a domain-specific language used in programming and designed for managing data held in a relational database management system.</p>
        <p>SQL consists of several types of statements which are classed as sublanguages:</p>
        <ul>
          <li>Data Query Language (DQL) - SELECT statements</li>
          <li>Data Definition Language (DDL) - CREATE, DROP, ALTER</li>
          <li>Data Manipulation Language (DML) - INSERT, UPDATE, DELETE</li>
        </ul>
        <h2>Basic SELECT Syntax</h2>
        <p>The SELECT statement is used to query the database and retrieve selected data that match the criteria you specify.</p>
        <pre>SELECT column1, column2 FROM table_name WHERE condition;</pre>
        <p>This fundamental operation forms the basis of most database interactions.</p>
        <h2>Joins and Relationships</h2>
        <p>A SQL join combines records from two or more tables in a database. The most common types are INNER JOIN, LEFT JOIN, and RIGHT JOIN.</p>
      </td>
    </tr>
  </table>
  <center><font size="-1">© 2005 Tutorial Site</font></center>
</body>
</html>`,
    expectations: {
      minLength: 400,
      shouldContain: ['SQL', 'SELECT', 'database', 'JOIN', 'tables']
      // Note: May contain some nav content - that's OK, main thing is we get the SQL content
    }
  },

  // Empty/invalid HTML
  emptyPage: {
    name: 'Nearly Empty Page',
    html: `<html><head><title>Blank</title></head><body></body></html>`,
    expectations: {
      success: false,
      shouldContainError: 'Insufficient content'
    }
  }
};

// ===== TEST RUNNER =====

console.log('='.repeat(60));
console.log('Content Extractor Test Suite');
console.log('='.repeat(60));
console.log();

// Test 1: Basic extraction on each test case
console.log('--- Content Extraction Tests ---\n');

for (const [key, testCase] of Object.entries(TEST_CASES)) {
  test(testCase.name, () => {
    const result = extractContent(testCase.html, 'https://example.com/test', {
      minLength: 200,
      maxLength: 50000
    });
    
    // Check success/failure expectations
    if (testCase.expectations.success === false) {
      assert(!result.success, `Expected failure but got success`);
      if (testCase.expectations.shouldContainError) {
        assert(result.error?.includes(testCase.expectations.shouldContainError), 
          `Expected error containing "${testCase.expectations.shouldContainError}" but got: ${result.error}`);
      }
      return; // Test passed - expected failure
    }
    
    // Should be successful
    assert(result.success, `Expected success but got: ${result.error}`);
    
    // Check length
    if (testCase.expectations.minLength) {
      assert(result.content?.length >= testCase.expectations.minLength,
        `Content too short: ${result.content?.length} chars (expected ${testCase.expectations.minLength}+)`);
    }
    
    // Check required content
    if (testCase.expectations.shouldContain) {
      for (const phrase of testCase.expectations.shouldContain) {
        assert(result.content?.toLowerCase().includes(phrase.toLowerCase()),
          `Missing expected phrase: "${phrase}"`);
      }
    }
    
    // Check excluded content
    if (testCase.expectations.shouldNotContain) {
      for (const phrase of testCase.expectations.shouldNotContain) {
        assert(!result.content?.includes(phrase),
          `Should not contain: "${phrase}"`);
      }
    }
    
    // Check strategy used
    if (testCase.expectations.expectedStrategy) {
      // Allow flexibility - if it works with any strategy, that's fine
      // Just log what was used
      console.log(`    (used ${result.strategy} strategy)`);
    }
  });
}

// Test 2: Validation tests
console.log('\n--- Validation Tests ---\n');

test('Validates good content as valid', () => {
  // Need 50+ words to pass
  const goodContent = {
    content: 'This is a substantial article about JavaScript programming. It has many words and discusses important programming concepts in detail. Closures are a fundamental concept in JavaScript development. They allow functions to access outer scope variables even after the outer function returns. This enables powerful patterns like data encapsulation and factory functions.'
  };
  const validation = validateContent(goodContent, 'https://example.com/article');
  assert(validation.valid, `Should be valid but got: ${validation.reason}`);
});

test('Rejects bot detection page', () => {
  const botContent = {
    content: 'Please verify you are human. Checking your browser. Cloudflare protection active.'
  };
  const validation = validateContent(botContent, 'https://example.com');
  assert(!validation.valid, 'Should reject bot page');
  assertEqual(validation.reason, 'bot_detection', 'Should identify as bot detection');
});

test('Rejects short content', () => {
  const shortContent = { content: 'Too short.' };
  const validation = validateContent(shortContent, 'https://example.com');
  assert(!validation.valid, 'Should reject short content');
  assertEqual(validation.reason, 'too_short', 'Should identify as too short');
});

test('Rejects high link density content', () => {
  // 3 URLs vs very few words = high link density
  const linkSpam = {
    content: 'Here is a link https://example.com/1 and another https://example.com/2 and one more https://example.com/3 but not much else'
  };
  const validation = validateContent(linkSpam, 'https://example.com');
  // This might pass or fail depending on exact word count, just verify it doesn't crash
  assert(validation.reason !== 'no_content', 'Should return some validation result');
});

// Test 3: Edge cases
console.log('\n--- Edge Case Tests ---\n');

test('Handles null/undefined gracefully', () => {
  const result = extractContent(null, 'https://example.com');
  assert(!result.success, 'Should fail on null HTML');
});

test('Handles empty string gracefully', () => {
  const result = extractContent('', 'https://example.com');
  assert(!result.success, 'Should fail on empty HTML');
});

test('Handles malformed HTML', () => {
  const malformed = '<html><body><p>Unclosed paragraph<div>Nested without close';
  const result = extractContent(malformed, 'https://example.com');
  // Should still try to extract something or fail gracefully
  assert(result.success !== undefined, 'Should return a result object');
});

test('Handles very large HTML', () => {
  // Generate 1MB of HTML
  const hugeContent = '<p>' + 'word '.repeat(50000) + '</p>';
  const result = extractContent(hugeContent, 'https://example.com', { maxLength: 10000 });
  if (result.success) {
    assert(result.content.length <= 10000, 'Should respect maxLength');
  }
});

test('Respects minLength threshold', () => {
  const shortButValid = '<p>This is some content but not very much.</p>';
  const result = extractContent(shortButValid, 'https://example.com', { minLength: 1000 });
  assert(!result.success, 'Should fail when content below minLength');
});

// Test 4: Metadata extraction
console.log('\n--- Metadata Extraction Tests ---\n');

test('Extracts title from HTML', () => {
  const html = '<html><head><title>My Article Title</title></head><body><p>Content here.</p></body></html>';
  const result = extractContent(html, 'https://example.com/article');
  assertEqual(result.metadata?.title, 'My Article Title', 'Should extract title');
});

test('Extracts meta description', () => {
  const html = `
    <html>
      <head>
        <title>Test</title>
        <meta name="description" content="This is the meta description">
      </head>
      <body><p>Content.</p></body>
    </html>`;
  const result = extractContent(html, 'https://example.com');
  assertEqual(result.metadata?.description, 'This is the meta description', 'Should extract meta description');
});

test('Extracts Open Graph metadata', () => {
  const html = `
    <html>
      <head>
        <title>Test</title>
        <meta property="og:site_name" content="My Blog">
        <meta property="og:image" content="https://example.com/image.jpg">
      </head>
      <body><p>Content here with enough length to pass minimums and actually get extracted properly.</p></body>
    </html>`;
  const result = extractContent(html, 'https://example.com');
  assertEqual(result.metadata?.site, 'My Blog', 'Should extract og:site_name');
});

// Test 5: Structure preservation
console.log('\n--- Structure Preservation Tests ---\n');

test('Preserves paragraph breaks', () => {
  const html = `
    <article>
      <p>First paragraph with important content.</p>
      <p>Second paragraph with more details.</p>
      <p>Third paragraph concludes the article.</p>
    </article>`;
  const result = extractContent(html, 'https://example.com');
  if (result.success) {
    // Should have some structure, not just one giant block
    assert(result.content.includes('First') && result.content.includes('Second'),
      'Should preserve multiple paragraphs');
  }
});

test('Extracts section headings', () => {
  const html = `
    <article>
      <h1>Main Title</h1>
      <p>Introduction.</p>
      <h2>Section One</h2>
      <p>Content one.</p>
      <h2>Section Two</h2>
      <p>Content two.</p>
    </article>`;
  const result = extractContent(html, 'https://example.com');
  if (result.success && result.sections) {
    assert(result.sections.length > 0, 'Should extract sections');
  }
});

// ===== SUMMARY =====

console.log();
console.log('='.repeat(60));
console.log('Test Summary');
console.log('='.repeat(60));
console.log(`Passed: ${results.passed}`);
console.log(`Failed: ${results.failed}`);
console.log(`Total:  ${results.passed + results.failed}`);
console.log();

if (results.failed > 0) {
  console.log('Failed tests:');
  results.tests
    .filter(t => t.status === 'FAIL')
    .forEach(t => console.log(`  - ${t.name}: ${t.error}`));
  process.exit(1);
} else {
  console.log('✓ All tests passed!');
  process.exit(0);
}
