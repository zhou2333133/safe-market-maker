import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const ignored = new Set(['node_modules', 'dist', '.git', '.safe-mm', 'coverage']);
const secretPatterns = [
  { name: 'raw-private-key-assignment', pattern: /(PRIVATE_KEY|privateKey)\s*[:=]\s*['"]?(0x)?[a-fA-F0-9]{64}/ },
  { name: 'jwt-token', pattern: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { name: 'polymarket-secret', pattern: /(apiSecret|POLYMARKET_API_SECRET)\s*[:=]\s*['"][^'"]{16,}/ }
];

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    if (ignored.has(entry)) continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) walk(full, files);
    else files.push(full);
  }
  return files;
}

const hits = [];
for (const file of walk(root)) {
  if (!/\.(ts|js|json|yaml|yml|md)$/.test(file)) continue;
  const content = readFileSync(file, 'utf8');
  for (const { name, pattern } of secretPatterns) {
    if (pattern.test(content)) {
      hits.push(`${name}: ${file}`);
    }
  }
}

if (hits.length > 0) {
  console.error('Potential secrets found:\n' + hits.join('\n'));
  process.exit(1);
}

console.log('No obvious secrets found.');
