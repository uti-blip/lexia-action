import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temp = mkdtempSync(join(tmpdir(), 'lexia-package-'));

try {
  const npmCli = process.env.npm_execpath;
  assert.ok(npmCli, 'npm_execpath is required for the cross-platform package smoke test');
  const packed = JSON.parse(execFileSync(process.execPath, [npmCli, 'pack', '--json', '--ignore-scripts', '--pack-destination', temp], {
    cwd: root,
    encoding: 'utf8',
  }));
  // npm 11 returns an object for a single package; older npm versions return
  // an array. Keep the smoke test compatible with both output formats.
  const result = Array.isArray(packed) ? packed[0] : packed.filename ? packed : Object.values(packed)[0];
  assert.ok(result?.filename, 'npm pack did not return an archive filename');
  const archive = join(temp, result.filename);
  execFileSync('tar', ['-xf', archive, '-C', temp]);
  const packageRoot = join(temp, 'package');
  const bundle = readFileSync(join(packageRoot, 'dist', 'index.js'), 'utf8');
  assert.ok(!bundle.includes('require("@actions/'), 'bundle contains an external @actions dependency');
  const smoke = spawnSync(process.execPath, [join(packageRoot, 'dist', 'index.js')], {
    cwd: packageRoot,
    env: { PATH: process.env.PATH ?? '' },
    encoding: 'utf8',
  });
  const output = `${smoke.stdout}${smoke.stderr}`;
  assert.equal(smoke.status, 1, 'bundle without required inputs must fail cleanly');
  assert.match(output, /Missing required input: api-token/);
  assert.doesNotMatch(output, /Cannot find module|MODULE_NOT_FOUND/);

  const mockFetch = join(temp, 'mock-fetch.cjs');
  const outputFile = join(temp, 'github-output.txt');
  const summaryFile = join(temp, 'github-summary.md');
  writeFileSync(mockFetch, `
globalThis.fetch = async () => new Response(JSON.stringify({
  audit_id: 'smoke-audit', status: 'completed', progress: 100,
  conclusion: 'success', compliance_score: 95, risk_level: 'minimal',
  artifacts: [], links: { self: '/v1/ci/audits/smoke-audit', dashboard: 'https://lexiafordev.vercel.app/audits/smoke-audit' }
}), { status: 202, headers: { 'content-type': 'application/json' } });
`, 'utf8');
  const functional = spawnSync(process.execPath, [join(packageRoot, 'dist', 'index.js')], {
    cwd: packageRoot,
    env: {
      PATH: process.env.PATH ?? '',
      NODE_OPTIONS: `--require=${mockFetch}`,
      'INPUT_API-TOKEN': 'smoke-token',
      'INPUT_WORKSPACE-ID': 'smoke-workspace',
      'INPUT_API-URL': 'https://lexia-hwhe.onrender.com',
      'INPUT_WAIT-FOR-RESULT': 'true',
      'INPUT_MINIMUM-SCORE': '80',
      GITHUB_REPOSITORY: 'lexia/smoke',
      GITHUB_REPOSITORY_ID: '123',
      GITHUB_SERVER_URL: 'https://github.com',
      GITHUB_SHA: 'a'.repeat(40),
      GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_REF: 'refs/heads/main',
      GITHUB_REF_NAME: 'main',
      GITHUB_RUN_ID: '1234',
      GITHUB_RUN_ATTEMPT: '1',
      GITHUB_ACTOR: 'smoke',
      GITHUB_WORKFLOW: 'smoke',
      GITHUB_JOB: 'smoke',
      GITHUB_OUTPUT: outputFile,
      GITHUB_STEP_SUMMARY: summaryFile,
    },
    encoding: 'utf8',
  });
  assert.equal(functional.status, 0, `${functional.stdout}${functional.stderr}`);
  assert.match(readFileSync(outputFile, 'utf8'), /audit-id<<[\s\S]*smoke-audit/);
  assert.match(readFileSync(summaryFile, 'utf8'), /95\/100/);
  process.stdout.write('packed clean archive runs end-to-end without node_modules\n');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
