import { readdirSync, statSync, readFileSync } from 'fs';
import { join, extname } from 'path';

// Blacklist patterns (common ignore patterns)
const BLACKLIST = new Set([
  'node_modules', '.git', '.vscode', 'dist', 'build', 'coverage',
  '__pycache__', '.pytest_cache', '.mypy_cache', 'venv', '.venv',
  'target', 'bin', 'obj', '.next', '.nuxt', 'vendor'
]);

// Binary file extensions (skip these)
const BINARY_EXTS = new Set([
  '.exe', '.dll', '.so', '.dylib', '.bin', '.dat',
  '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.ico', '.webp',
  '.mp4', '.avi', '.mov', '.wmv', '.flv', '.mkv',
  '.mp3', '.wav', '.ogg', '.flac', '.aac',
  '.zip', '.tar', '.gz', '.7z', '.rar', '.bz2',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.db', '.sqlite', '.mdb'
]);

// Magic bytes check for text files
function isTextFile(filePath) {
  try {
    const buffer = readFileSync(filePath, { encoding: null, flag: 'r' });
    const sample = buffer.slice(0, 512);
    
    // Check for null bytes (binary indicator)
    for (let i = 0; i < sample.length; i++) {
      if (sample[i] === 0) return false;
    }
    return true;
  } catch (err) {
    return false;
  }
}

function scanDirectory(dirPath, stats = { total: 0, filtered: 0, readable: 0, errors: 0 }, lastLog = { time: Date.now(), count: 0 }) {
  try {
    const entries = readdirSync(dirPath, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name);
      stats.total++;
      
      // Progress logging every 10k entries
      if (stats.total - lastLog.count >= 10000) {
        const elapsed = (Date.now() - lastLog.time) / 1000;
        console.log(`  ${stats.total.toLocaleString()} entries (${stats.readable.toLocaleString()} readable) - ${(stats.total / elapsed).toFixed(0)}/s`);
        lastLog.count = stats.total;
        lastLog.time = Date.now();
      }
      
      // Filter blacklisted directories
      if (entry.isDirectory()) {
        if (BLACKLIST.has(entry.name)) {
          continue; // Skip blacklisted dirs
        }
        scanDirectory(fullPath, stats, lastLog);
      } else if (entry.isFile()) {
        stats.filtered++;
        
        // Filter binary files by extension
        const ext = extname(entry.name).toLowerCase();
        if (BINARY_EXTS.has(ext)) {
          continue;
        }
        
        // Check if readable (text file)
        if (isTextFile(fullPath)) {
          stats.readable++;
        }
      }
    }
  } catch (err) {
    stats.errors++;
  }
  
  return stats;
}

// Run benchmark
const targetPath = process.argv[2] || process.cwd();

console.log(`\n🔍 Filesystem Scan Benchmark`);
console.log(`Target: ${targetPath}\n`);

const startTime = performance.now();
const stats = scanDirectory(targetPath);
const endTime = performance.now();
const duration = endTime - startTime;

console.log(`Results:`);
console.log(`  Total entries:     ${stats.total.toLocaleString()}`);
console.log(`  After blacklist:   ${stats.filtered.toLocaleString()}`);
console.log(`  Readable files:    ${stats.readable.toLocaleString()}`);
console.log(`  Errors:            ${stats.errors}`);
console.log(`\nPerformance:`);
console.log(`  Duration:          ${duration.toFixed(2)}ms (${(duration/1000).toFixed(2)}s)`);
console.log(`  Files/second:      ${(stats.readable / (duration/1000)).toFixed(0)}`);
console.log(`  Avg per file:      ${(duration / stats.readable).toFixed(2)}ms`);
