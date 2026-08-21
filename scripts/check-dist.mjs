import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ncc = join(root, 'node_modules', '@vercel', 'ncc', 'dist', 'ncc', 'cli.js');
const temp = mkdtempSync(join(tmpdir(), 'lexia-dist-'));

try {
  const first = join(temp, 'first');
  const second = join(temp, 'second');
  const args = ['build', join(root, 'src', 'index.ts'), '--minify', '--no-source-map-register', '--target', 'es2022'];
  execFileSync(process.execPath, [ncc, ...args, '-o', first], { cwd: root, stdio: 'ignore' });
  execFileSync(process.execPath, [ncc, ...args, '-o', second], { cwd: root, stdio: 'ignore' });
  const committed = readFileSync(join(root, 'dist', 'index.js'));
  const builtOnce = readFileSync(join(first, 'index.js'));
  const builtTwice = readFileSync(join(second, 'index.js'));
  assert.deepEqual(builtOnce, builtTwice, 'ncc bundle is not reproducible');
  assert.deepEqual(committed, builtOnce, 'dist/index.js is stale; run npm run build');
  process.stdout.write('dist/index.js is reproducible and synchronized\n');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
