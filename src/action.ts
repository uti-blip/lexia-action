import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { ActionIO } from './io';

export type FailOn = 'non-compliant' | 'audit-failure' | 'never';
type Fetch = typeof globalThis.fetch;

export interface Dependencies {
  fetch: Fetch;
  sleep(milliseconds: number): Promise<void>;
  now(): number;
}

interface Inputs {
  token: string;
  workspaceId: string;
  apiUrl: string;
  wait: boolean;
  timeoutMs: number;
  pollIntervalMs: number;
  minimumScore: number;
  failOn: FailOn;
}

export interface AuditState {
  auditId: string;
  status: string;
  progress?: number;
  conclusion?: 'success' | 'failure';
  complianceScore?: number;
  riskLevel?: string;
  currentStep?: string;
  errorCode?: string;
  dashboardUrl?: string;
  jsonReportUrl?: string;
  pdfReportUrl?: string;
  replayed?: boolean;
}

const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_HTTP_ATTEMPTS = 4;
const REQUEST_TIMEOUT_MS = 30_000;
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const OFFICIAL_API_ORIGINS = new Set([
  'https://lexia-hwhe.onrender.com',
]);

class ActionTimeoutError extends Error {
  public constructor() {
    super('Lexia audit did not complete before timeout');
    this.name = 'ActionTimeoutError';
  }
}

function required(value: string, label: string): string {
  if (!value) throw new Error(`Missing required input: ${label}`);
  return value;
}

function parseBoolean(value: string, label: string): boolean {
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${label} must be true or false`);
}

function parseNumber(value: string, label: string, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function parseInputs(io: ActionIO): Inputs {
  const token = required(io.getInput('api-token'), 'api-token');
  io.addSecret(token);
  const rawFailOn = io.getInput('fail-on') || 'non-compliant';
  if (!['non-compliant', 'audit-failure', 'never'].includes(rawFailOn)) {
    throw new Error('fail-on must be non-compliant, audit-failure, or never');
  }
  return {
    token,
    workspaceId: required(io.getInput('workspace-id'), 'workspace-id'),
    apiUrl: normalizeApiUrl(io.getInput('api-url') || 'https://lexia-hwhe.onrender.com'),
    wait: parseBoolean(io.getInput('wait-for-result') || 'true', 'wait-for-result'),
    timeoutMs: parseNumber(io.getInput('timeout-minutes') || '20', 'timeout-minutes', 1, 120) * 60_000,
    pollIntervalMs: parseNumber(io.getInput('poll-interval-seconds') || '5', 'poll-interval-seconds', 2, 60) * 1000,
    minimumScore: parseNumber(io.getInput('minimum-score') || '80', 'minimum-score', 0, 100),
    failOn: rawFailOn as FailOn,
  };
}

export function normalizeApiUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('api-url must be a valid HTTPS URL');
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('api-url must be a credential-free HTTPS URL');
  }
  if (!OFFICIAL_API_ORIGINS.has(url.origin.toLowerCase()) || url.pathname !== '/') {
    throw new Error('api-url must be an exact official Lexia API origin');
  }
  url.hash = '';
  url.search = '';
  return url.toString().replace(/\/$/, '');
}

function positiveInteger(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function pullRequestContext(env: NodeJS.ProcessEnv): { number?: number; headSha?: string } {
  const refMatch = /^refs\/pull\/(\d+)\//.exec(env.GITHUB_REF ?? '');
  const refNumber = refMatch?.[1] ? positiveInteger(refMatch[1]) : undefined;
  const eventPath = env.GITHUB_EVENT_PATH;
  if (!eventPath) return { number: refNumber };
  try {
    const raw = readFileSync(eventPath, { encoding: 'utf8' });
    if (raw.length > MAX_RESPONSE_BYTES) return { number: refNumber };
    const event = JSON.parse(raw) as { pull_request?: { number?: unknown; head?: { sha?: unknown } }; number?: unknown };
    const candidate = event.pull_request?.number ?? event.number;
    const number = typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate > 0 ? candidate : refNumber;
    const sha = event.pull_request?.head?.sha;
    const headSha = typeof sha === 'string' && /^[a-f0-9]{40,64}$/i.test(sha) ? sha : undefined;
    return { number, headSha };
  } catch {
    return { number: refNumber };
  }
}

export function buildCreateRequest(inputs: Pick<Inputs, 'workspaceId'>, env: NodeJS.ProcessEnv): Record<string, unknown> {
  const repository = required(env.GITHUB_REPOSITORY ?? '', 'GitHub repository context');
  const serverUrl = env.GITHUB_SERVER_URL || 'https://github.com';
  const parsedServer = new URL(serverUrl);
  if (parsedServer.protocol !== 'https:') throw new Error('GITHUB_SERVER_URL must use HTTPS');
  if (parsedServer.origin !== 'https://github.com') {
    throw new Error('Lexia v1 currently supports repositories hosted on github.com; GitHub Enterprise Server is not supported');
  }
  const pullRequest = pullRequestContext(env);
  const github: Record<string, unknown> = {
    sha: pullRequest.headSha || required(env.GITHUB_SHA ?? '', 'GitHub commit SHA'),
    event_name: required(env.GITHUB_EVENT_NAME ?? '', 'GitHub event name'),
    ref: required(env.GITHUB_REF ?? '', 'GitHub ref'),
    run_id: required(env.GITHUB_RUN_ID ?? '', 'GitHub run ID'),
    run_attempt: required(env.GITHUB_RUN_ATTEMPT ?? '', 'GitHub run attempt'),
    actor: env.GITHUB_ACTOR || 'unknown',
    workflow: env.GITHUB_WORKFLOW || 'unknown',
  };
  if (env.GITHUB_JOB) github.job = env.GITHUB_JOB;
  const repositoryId = positiveInteger(env.GITHUB_REPOSITORY_ID);
  if (repositoryId) github.repository_id = repositoryId;
  if (pullRequest.number) github.pull_request_number = pullRequest.number;
  return {
    workspace_id: inputs.workspaceId,
    repository_url: `${parsedServer.origin}/${repository}`,
    branch: required(env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME || '', 'GitHub branch context'),
    github,
  };
}

export function buildIdempotencyKey(body: Record<string, unknown>): string {
  const digest = createHash('sha256').update(JSON.stringify(body)).digest('hex');
  return `gha-v1-${digest}`;
}

function retryAfterMilliseconds(value: string | null, attempt: number, now: number): number {
  const fallback = Math.min(1000 * 2 ** attempt, 10_000);
  if (!value) return fallback;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 30_000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.min(Math.max(date - now, 0), 30_000);
  return fallback;
}

async function limitedJson(response: Response): Promise<unknown> {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new Error('Lexia API response exceeded 1 MB');
  }
  if (!response.body) return {};
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('Lexia API response exceeded 1 MB');
      }
      chunks.push(value);
    }
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error('Lexia API returned invalid JSON');
  }
}

async function requestJson(
  url: string,
  init: RequestInit,
  token: string,
  deadline: number,
  dependencies: Dependencies,
): Promise<unknown> {
  for (let attempt = 0; attempt < MAX_HTTP_ATTEMPTS; attempt += 1) {
    const remaining = deadline - dependencies.now();
    if (remaining <= 0) throw new ActionTimeoutError();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(REQUEST_TIMEOUT_MS, remaining));
    let response: Response;
    try {
      response = await dependencies.fetch(url, {
        ...init,
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
          ...init.headers,
        },
      });
    } catch (error) {
      clearTimeout(timer);
      if (error instanceof ActionTimeoutError) throw error;
      if (attempt + 1 >= MAX_HTTP_ATTEMPTS) throw new Error('Lexia API request failed after bounded retries');
      const delay = Math.min(1000 * 2 ** attempt, Math.max(deadline - dependencies.now(), 0));
      if (delay <= 0) throw new ActionTimeoutError();
      await dependencies.sleep(delay);
      continue;
    }
    if (response.ok) {
      try {
        return await limitedJson(response);
      } catch (error) {
        if (!controller.signal.aborted) throw error;
        if (attempt + 1 >= MAX_HTTP_ATTEMPTS) throw new Error('Lexia API request failed after bounded retries');
        const delay = Math.min(1000 * 2 ** attempt, Math.max(deadline - dependencies.now(), 0));
        if (delay <= 0) throw new ActionTimeoutError();
        await dependencies.sleep(delay);
        continue;
      } finally {
        clearTimeout(timer);
      }
    }
    clearTimeout(timer);
    const retryable = response.status === 429 || response.status >= 500;
    await response.body?.cancel();
    if (!retryable || attempt + 1 >= MAX_HTTP_ATTEMPTS) {
      const requestId = response.headers.get('x-request-id');
      const suffix = requestId && /^[A-Za-z0-9._:-]{1,128}$/.test(requestId) ? ` (request ${requestId})` : '';
      throw new Error(`Lexia API returned HTTP ${response.status}${suffix}`);
    }
    const delay = Math.min(
      retryAfterMilliseconds(response.headers.get('retry-after'), attempt, dependencies.now()),
      Math.max(deadline - dependencies.now(), 0),
    );
    if (dependencies.now() >= deadline) throw new ActionTimeoutError();
    if (delay > 0) await dependencies.sleep(delay);
  }
  throw new Error('Lexia API request failed after bounded retries');
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(...values: unknown[]): string | undefined {
  return values.find((value) => typeof value === 'string' && value.length > 0) as string | undefined;
}

function numberValue(...values: unknown[]): number | undefined {
  const candidate = values.find((value) => typeof value === 'number' && Number.isFinite(value));
  return candidate as number | undefined;
}

function resolveUrl(value: string | undefined, apiUrl?: string): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value, apiUrl ? `${apiUrl}/` : undefined).toString();
  } catch {
    return undefined;
  }
}

export function parseAuditState(value: unknown, apiUrl?: string): AuditState {
  const data = object(value);
  const links = object(data.links);
  const artifacts = object(data.artifacts);
  const artifactList = Array.isArray(data.artifacts) ? data.artifacts.map(object) : [];
  const jsonArtifact = artifactList.find((artifact) => stringValue(artifact.type, artifact.format, artifact.kind)?.toLowerCase() === 'json');
  const pdfArtifact = artifactList.find((artifact) => stringValue(artifact.type, artifact.format, artifact.kind)?.toLowerCase() === 'pdf');
  const error = object(data.error);
  const auditId = stringValue(data.audit_id, data.auditId);
  if (!auditId) throw new Error('Lexia API response is missing audit_id');
  const conclusion = stringValue(data.conclusion);
  return {
    auditId,
    status: stringValue(data.status) || 'queued',
    progress: numberValue(data.progress),
    conclusion: conclusion === 'success' || conclusion === 'failure' ? conclusion : undefined,
    complianceScore: numberValue(data.compliance_score, data.score, data.complianceScore),
    riskLevel: stringValue(data.risk_level, data.risk, data.riskLevel),
    currentStep: stringValue(data.current_step, data.currentStep),
    errorCode: stringValue(error.code, data.error_code),
    dashboardUrl: resolveUrl(stringValue(links.dashboard, data.dashboard_url), apiUrl),
    jsonReportUrl: resolveUrl(stringValue(jsonArtifact?.download_url, jsonArtifact?.url, artifacts.json_url, artifacts.json, data.json_report_url), apiUrl),
    pdfReportUrl: resolveUrl(stringValue(pdfArtifact?.download_url, pdfArtifact?.url, artifacts.pdf_url, artifacts.pdf, data.pdf_report_url, links.report), apiUrl),
    replayed: typeof data.replayed === 'boolean' ? data.replayed : undefined,
  };
}

function mergeState(previous: AuditState, next: AuditState): AuditState {
  return {
    ...previous,
    ...next,
    complianceScore: next.complianceScore ?? previous.complianceScore,
    riskLevel: next.riskLevel ?? previous.riskLevel,
    dashboardUrl: next.dashboardUrl ?? previous.dashboardUrl,
    jsonReportUrl: next.jsonReportUrl ?? previous.jsonReportUrl,
    pdfReportUrl: next.pdfReportUrl ?? previous.pdfReportUrl,
  };
}

function escapeMarkdown(value: string): string {
  return value.replace(/[\\`|<>]/g, '\\$&').replace(/[\r\n]+/g, ' ');
}

function markdownLink(label: string, value: string | undefined): string {
  if (!value) return '—';
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return escapeMarkdown(value);
    return `[${label}](${url.toString().replace(/[()]/g, encodeURIComponent)})`;
  } catch {
    return escapeMarkdown(value);
  }
}

function actionConclusion(state: AuditState, inputs: Inputs): 'success' | 'failure' | 'pending' {
  if (!TERMINAL_STATUSES.has(state.status)) return 'pending';
  if (state.status === 'failed' || state.status === 'cancelled' || state.conclusion === 'failure') return 'failure';
  if (inputs.failOn === 'non-compliant') {
    if (state.complianceScore === undefined || state.complianceScore < inputs.minimumScore) return 'failure';
  }
  return 'success';
}

function publish(io: ActionIO, state: AuditState, conclusion: string): void {
  const outputs: Record<string, string> = {
    'audit-id': state.auditId,
    status: state.status,
    conclusion,
    'compliance-score': state.complianceScore?.toString() ?? '',
    'risk-level': state.riskLevel ?? '',
    'dashboard-url': state.dashboardUrl ?? '',
    'json-report-url': state.jsonReportUrl ?? '',
    'pdf-report-url': state.pdfReportUrl ?? '',
  };
  for (const [name, value] of Object.entries(outputs)) io.setOutput(name, value);
}

function summary(state: AuditState, conclusion: string, inputs: Inputs): string {
  const score = state.complianceScore === undefined ? '—' : `${state.complianceScore}/100`;
  return [
    '## Lexia EU AI Act audit',
    '',
    '| Field | Result |',
    '| --- | --- |',
    `| Audit | \`${escapeMarkdown(state.auditId)}\` |`,
    `| Status | **${escapeMarkdown(state.status)}** |`,
    `| Policy conclusion | **${escapeMarkdown(conclusion)}** |`,
    `| Compliance score | ${escapeMarkdown(score)} (minimum ${inputs.minimumScore}) |`,
    `| Risk level | ${escapeMarkdown(state.riskLevel ?? '—')} |`,
    `| Dashboard | ${markdownLink('Open audit', state.dashboardUrl)} |`,
    `| JSON report | ${state.jsonReportUrl ? 'Available through the authenticated \`json-report-url\` output' : '—'} |`,
    `| PDF report | ${state.pdfReportUrl ? 'Available through the authenticated \`pdf-report-url\` output' : '—'} |`,
    '',
  ].join('\n');
}

async function poll(
  initial: AuditState,
  inputs: Inputs,
  deadline: number,
  dependencies: Dependencies,
  io: ActionIO,
): Promise<AuditState> {
  let state = initial;
  while (!TERMINAL_STATUSES.has(state.status)) {
    const remaining = deadline - dependencies.now();
    if (remaining <= 0) throw new ActionTimeoutError();
    await dependencies.sleep(Math.min(inputs.pollIntervalMs, remaining));
    if (dependencies.now() >= deadline) throw new ActionTimeoutError();
    const response = await requestJson(
      `${inputs.apiUrl}/v1/ci/audits/${encodeURIComponent(state.auditId)}`,
      { method: 'GET' },
      inputs.token,
      deadline,
      dependencies,
    );
    state = mergeState(state, parseAuditState(response, inputs.apiUrl));
    io.info(`Lexia audit ${state.auditId}: ${state.status}${state.progress === undefined ? '' : ` (${state.progress}%)`}`);
  }
  return state;
}

const defaultDependencies: Dependencies = {
  fetch: globalThis.fetch,
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  now: () => Date.now(),
};

export async function runAction(io: ActionIO, dependencies: Dependencies = defaultDependencies): Promise<AuditState> {
  const inputs = parseInputs(io);
  const body = buildCreateRequest(inputs, io.env);
  const deadline = dependencies.now() + inputs.timeoutMs;
  const idempotencyKey = buildIdempotencyKey(body);
  io.info(`Starting Lexia audit for ${String(body.repository_url)} at ${String(body.branch)}`);

  const created = await requestJson(
    `${inputs.apiUrl}/v1/ci/audits`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify(body),
    },
    inputs.token,
    deadline,
    dependencies,
  );
  let state = parseAuditState(created, inputs.apiUrl);
  io.info(`Lexia audit accepted: ${state.auditId}${state.replayed ? ' (idempotent replay)' : ''}`);

  if (inputs.wait) {
    try {
      state = await poll(state, inputs, deadline, dependencies, io);
    } catch (error) {
      if (error instanceof ActionTimeoutError) {
        const timedOut = { ...state, status: 'timed_out' };
        publish(io, timedOut, 'failure');
        io.writeSummary(summary(timedOut, 'failure', inputs));
        if (inputs.failOn === 'never') {
          io.warning(error.message);
          return timedOut;
        }
      }
      throw error;
    }
  }

  const conclusion = inputs.wait ? actionConclusion(state, inputs) : 'pending';
  publish(io, state, conclusion);
  io.writeSummary(summary(state, conclusion, inputs));

  if (conclusion === 'failure' && inputs.failOn !== 'never') {
    if (state.status === 'failed' || state.status === 'cancelled' || state.conclusion === 'failure') {
      throw new Error(`Lexia audit ended with status ${state.status}`);
    }
    throw new Error(`Lexia compliance score ${state.complianceScore ?? 'unavailable'} is below the required ${inputs.minimumScore}`);
  }
  if (conclusion === 'failure') io.warning('Lexia audit policy failed, but fail-on is set to never.');
  return state;
}
