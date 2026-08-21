import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildCreateRequest, buildIdempotencyKey, normalizeApiUrl, parseAuditState, runAction, type Dependencies } from '../src/action';
import type { ActionIO } from '../src/io';

class FakeIO implements ActionIO {
  public outputs: Record<string, string> = {};
  public infos: string[] = [];
  public warnings: string[] = [];
  public failures: string[] = [];
  public summaries: string[] = [];
  public secrets: string[] = [];

  public constructor(public env: NodeJS.ProcessEnv, private readonly inputs: Record<string, string> = {}) {}
  public getInput(name: string): string { return this.inputs[name] ?? ''; }
  public addSecret(value: string): void { this.secrets.push(value); }
  public setOutput(name: string, value: string): void { this.outputs[name] = value; }
  public info(message: string): void { this.infos.push(message); }
  public warning(message: string): void { this.warnings.push(message); }
  public setFailed(message: string): void { this.failures.push(message); }
  public writeSummary(markdown: string): void { this.summaries.push(markdown); }
}

const env: NodeJS.ProcessEnv = {
  GITHUB_REPOSITORY: 'lexia/example',
  GITHUB_REPOSITORY_ID: '123456',
  GITHUB_SERVER_URL: 'https://github.com',
  GITHUB_SHA: 'a'.repeat(40),
  GITHUB_EVENT_NAME: 'pull_request',
  GITHUB_REF: 'refs/pull/42/merge',
  GITHUB_HEAD_REF: 'feature/compliance',
  GITHUB_REF_NAME: '42/merge',
  GITHUB_RUN_ID: '987654321',
  GITHUB_RUN_ATTEMPT: '2',
  GITHUB_ACTOR: 'octocat',
  GITHUB_WORKFLOW: 'Lexia audit',
  GITHUB_JOB: 'audit',
};

const baseInputs: Record<string, string> = {
  'api-token': 'lexia_secret_token',
  'workspace-id': 'workspace-1',
  'api-url': 'https://lexia-hwhe.onrender.com',
  'wait-for-result': 'true',
  'timeout-minutes': '20',
  'poll-interval-seconds': '5',
  'minimum-score': '80',
  'fail-on': 'non-compliant',
};

function json(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function sequence(responses: Response[]): { dependencies: Dependencies; calls: Array<{ url: string; init?: RequestInit }>; sleeps: number[] } {
  let now = 1_000_000;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const sleeps: number[] = [];
  const dependencies: Dependencies = {
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      const response = responses.shift();
      if (!response) throw new Error('Unexpected fetch');
      return response;
    }) as typeof fetch,
    sleep: async (milliseconds) => { sleeps.push(milliseconds); now += milliseconds; },
    now: () => now,
  };
  return { dependencies, calls, sleeps };
}

test('creates, polls and publishes a complete policy result without leaking the token', async () => {
  const io = new FakeIO({ ...env }, baseInputs);
  const mock = sequence([
    json({ audit_id: 'audit-123', status: 'queued', replayed: false, links: { self: '/v1/ci/audits/audit-123' } }, 202),
    json({ audit_id: 'audit-123', status: 'running', progress: 55 }),
    json({
      audit_id: 'audit-123', status: 'completed', progress: 100, conclusion: 'success',
      compliance_score: 92, risk_level: 'limited',
      artifacts: { json_url: 'https://lexia-hwhe.onrender.com/reports/audit-123.json', pdf_url: 'https://lexia-hwhe.onrender.com/reports/audit-123.pdf' },
      links: { dashboard: 'https://lexiafordev.vercel.app/audits/audit-123' },
    }),
  ]);

  await runAction(io, mock.dependencies);

  assert.equal(mock.calls.length, 3);
  const request = JSON.parse(String(mock.calls[0]?.init?.body)) as Record<string, any>;
  assert.deepEqual(request, {
    workspace_id: 'workspace-1',
    repository_url: 'https://github.com/lexia/example',
    branch: 'feature/compliance',
    github: {
      sha: 'a'.repeat(40), event_name: 'pull_request', ref: 'refs/pull/42/merge',
      run_id: '987654321', run_attempt: '2', actor: 'octocat', workflow: 'Lexia audit', job: 'audit',
      repository_id: 123456, pull_request_number: 42,
    },
  });
  const headers = new Headers(mock.calls[0]?.init?.headers);
  assert.equal(headers.get('authorization'), 'Bearer lexia_secret_token');
  assert.match(headers.get('idempotency-key') ?? '', /^gha-v1-[a-f0-9]{64}$/);
  assert.equal(io.outputs['audit-id'], 'audit-123');
  assert.equal(io.outputs.status, 'completed');
  assert.equal(io.outputs.conclusion, 'success');
  assert.equal(io.outputs['compliance-score'], '92');
  assert.equal(io.outputs['risk-level'], 'limited');
  assert.equal(io.outputs['json-report-url'], 'https://lexia-hwhe.onrender.com/reports/audit-123.json');
  assert.match(io.summaries.join(''), /Compliance score \| 92\/100/);
  assert.match(io.summaries.join(''), /authenticated `json-report-url` output/);
  assert.doesNotMatch(io.summaries.join(''), /\[Download JSON\]/);
  assert.equal(io.secrets[0], 'lexia_secret_token');
  assert.ok(!JSON.stringify({ infos: io.infos, summaries: io.summaries }).includes('lexia_secret_token'));
});

test('derives the branch label from the runner and ignores a legacy branch input', async () => {
  const io = new FakeIO(
    { ...env },
    { ...baseInputs, branch: 'release/moving-target', 'wait-for-result': 'false' },
  );
  const mock = sequence([
    json({ audit_id: 'audit-pinned', status: 'queued', replayed: false }, 202),
  ]);

  await runAction(io, mock.dependencies);

  const request = JSON.parse(String(mock.calls[0]?.init?.body)) as Record<string, any>;
  assert.equal(request.branch, 'feature/compliance');
  assert.equal(request.github.sha, 'a'.repeat(40));
});

test('uses a deterministic idempotency key', () => {
  const body = buildCreateRequest({ workspaceId: 'workspace-1' }, { ...env, GITHUB_HEAD_REF: '', GITHUB_REF_NAME: 'main' });
  assert.equal(buildIdempotencyKey(body), buildIdempotencyKey(structuredClone(body)));
  const changed = structuredClone(body);
  (changed.github as Record<string, unknown>).run_attempt = '3';
  assert.notEqual(buildIdempotencyKey(body), buildIdempotencyKey(changed));
});

test('pins pull-request scans to pull_request.head.sha instead of the synthetic merge SHA', () => {
  const temp = mkdtempSync(join(tmpdir(), 'lexia-event-'));
  try {
    const eventPath = join(temp, 'event.json');
    const headSha = 'b'.repeat(40);
    writeFileSync(eventPath, JSON.stringify({ pull_request: { number: 73, head: { sha: headSha } } }), 'utf8');
    const body = buildCreateRequest(
      { workspaceId: 'workspace-1' },
      { ...env, GITHUB_EVENT_PATH: eventPath, GITHUB_SHA: 'c'.repeat(40), GITHUB_REF: 'refs/pull/73/merge' },
    );
    assert.equal((body.github as Record<string, unknown>).sha, headSha);
    assert.equal((body.github as Record<string, unknown>).pull_request_number, 73);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('parses the backend artifact list and resolves relative v1 URLs', () => {
  const state = parseAuditState({
    audit_id: 'audit-contract', status: 'completed', progress: 100, conclusion: 'success',
    compliance_score: 88, risk_level: 'high', error: null,
    artifacts: [
      { type: 'json', download_url: '/v1/ci/audits/audit-contract/artifacts/json' },
      { type: 'pdf', download_url: '/v1/ci/audits/audit-contract/artifacts/pdf' },
    ],
    links: { self: '/v1/ci/audits/audit-contract', dashboard: '/dashboard/audits/audit-contract' },
  }, 'https://lexia-hwhe.onrender.com');
  assert.equal(state.jsonReportUrl, 'https://lexia-hwhe.onrender.com/v1/ci/audits/audit-contract/artifacts/json');
  assert.equal(state.pdfReportUrl, 'https://lexia-hwhe.onrender.com/v1/ci/audits/audit-contract/artifacts/pdf');
  assert.equal(state.dashboardUrl, 'https://lexia-hwhe.onrender.com/dashboard/audits/audit-contract');
  assert.equal(state.riskLevel, 'high');
});

test('retries 429 and 5xx with bounded Retry-After delays', async () => {
  const io = new FakeIO({ ...env }, { ...baseInputs, 'wait-for-result': 'false' });
  const mock = sequence([
    json({ confidential: 'must not be logged' }, 429, { 'retry-after': '2' }),
    json({ confidential: 'must not be logged' }, 503),
    json({ audit_id: 'audit-retry', status: 'queued' }, 202),
  ]);
  await runAction(io, mock.dependencies);
  assert.deepEqual(mock.sleeps, [2000, 2000]);
  assert.equal(io.outputs.conclusion, 'pending');
  assert.ok(!JSON.stringify(io).includes('must not be logged'));
});

test('retries immediately when Retry-After is zero', async () => {
  const io = new FakeIO({ ...env }, { ...baseInputs, 'wait-for-result': 'false' });
  const mock = sequence([
    json({}, 429, { 'retry-after': '0' }),
    json({ audit_id: 'audit-immediate-retry', status: 'queued' }, 202),
  ]);
  await runAction(io, mock.dependencies);
  assert.equal(mock.calls.length, 2);
  assert.deepEqual(mock.sleeps, []);
});

test('stops retrying after four retryable responses', async () => {
  const io = new FakeIO({ ...env }, { ...baseInputs, 'wait-for-result': 'false' });
  const mock = sequence([
    json({ detail: 'one' }, 503), json({ detail: 'two' }, 503),
    json({ detail: 'three' }, 503), json({ detail: 'four' }, 503),
  ]);
  await assert.rejects(runAction(io, mock.dependencies), /HTTP 503/);
  assert.equal(mock.calls.length, 4);
  assert.deepEqual(mock.sleeps, [1000, 2000, 4000]);
  assert.ok(!JSON.stringify(io).includes('four'));
});

test('fails non-compliant policy below the configured score after publishing outputs', async () => {
  const io = new FakeIO({ ...env }, baseInputs);
  const mock = sequence([
    json({ audit_id: 'audit-low', status: 'completed', conclusion: 'success', compliance_score: 79 }, 202),
  ]);
  await assert.rejects(runAction(io, mock.dependencies), /79 is below the required 80/);
  assert.equal(io.outputs.conclusion, 'failure');
  assert.equal(io.outputs['compliance-score'], '79');
});

test('audit-failure ignores the score threshold and never is advisory for audit failure', async () => {
  const auditFailureIo = new FakeIO({ ...env }, { ...baseInputs, 'fail-on': 'audit-failure' });
  await runAction(auditFailureIo, sequence([
    json({ audit_id: 'audit-score', status: 'completed', conclusion: 'success', compliance_score: 25 }, 202),
  ]).dependencies);
  assert.equal(auditFailureIo.outputs.conclusion, 'success');

  const advisoryIo = new FakeIO({ ...env }, { ...baseInputs, 'fail-on': 'never' });
  await runAction(advisoryIo, sequence([
    json({ audit_id: 'audit-failed', status: 'failed', conclusion: 'failure', error: { code: 'SCAN_FAILED', message: 'private' } }, 202),
  ]).dependencies);
  assert.equal(advisoryIo.outputs.conclusion, 'failure');
  assert.match(advisoryIo.warnings.join(''), /fail-on is set to never/);
  assert.ok(!JSON.stringify(advisoryIo).includes('private'));
});

test('treats polling timeout as advisory only with fail-on never', async () => {
  const io = new FakeIO({ ...env }, { ...baseInputs, 'fail-on': 'never', 'timeout-minutes': '1', 'poll-interval-seconds': '60' });
  const mock = sequence([json({ audit_id: 'audit-timeout', status: 'queued' }, 202)]);
  const state = await runAction(io, mock.dependencies);
  assert.equal(state.status, 'timed_out');
  assert.equal(io.outputs.status, 'timed_out');
  assert.equal(io.outputs.conclusion, 'failure');
  assert.match(io.warnings.join(''), /before timeout/);
});

test('fails polling timeout under the default blocking policy', async () => {
  const io = new FakeIO({ ...env }, { ...baseInputs, 'timeout-minutes': '1', 'poll-interval-seconds': '60' });
  const mock = sequence([json({ audit_id: 'audit-timeout-blocking', status: 'queued' }, 202)]);
  await assert.rejects(runAction(io, mock.dependencies), /did not complete before timeout/);
  assert.equal(io.outputs.status, 'timed_out');
  assert.equal(io.outputs.conclusion, 'failure');
});

test('never includes an API error response body in the surfaced error', async () => {
  const io = new FakeIO({ ...env }, { ...baseInputs, 'wait-for-result': 'false' });
  const mock = sequence([json({ detail: 'secret backend details' }, 401, { 'x-request-id': 'req_123' })]);
  await assert.rejects(runAction(io, mock.dependencies), (error: Error) => {
    assert.equal(error.message, 'Lexia API returned HTTP 401 (request req_123)');
    assert.ok(!error.message.includes('secret backend details'));
    return true;
  });
});

test('rejects non-official and credential-bearing API URLs', () => {
  assert.equal(normalizeApiUrl('https://lexia-hwhe.onrender.com/'), 'https://lexia-hwhe.onrender.com');
  assert.throws(() => normalizeApiUrl('http://lexia-hwhe.onrender.com'), /credential-free HTTPS/);
  assert.throws(() => normalizeApiUrl('https://attacker.example'), /official Lexia API origin/);
  assert.throws(() => normalizeApiUrl('https://lexia-hwhe.onrender.com:4443'), /official Lexia API origin/);
  assert.throws(() => normalizeApiUrl('https://lexia-hwhe.onrender.com/unexpected'), /official Lexia API origin/);
  assert.throws(() => normalizeApiUrl('https://token@lexia-hwhe.onrender.com'), /credential-free HTTPS/);
});

test('rejects GitHub Enterprise Server contexts explicitly', () => {
  assert.throws(
    () => buildCreateRequest({ workspaceId: 'workspace-1' }, { ...env, GITHUB_SERVER_URL: 'https://github.enterprise.example' }),
    /GitHub Enterprise Server is not supported/,
  );
});
