# Lexia EU AI Act Audit Action

[![GitHub Marketplace](https://img.shields.io/badge/Marketplace-Lexia%20EU%20AI%20Act%20Audit-6f42c1?logo=github)](https://github.com/marketplace/actions/lexia-eu-ai-act-audit)

Run a durable Lexia audit from a push, pull request, schedule, or manual workflow. The action submits immutable GitHub run metadata, waits for the worker-backed audit, writes a job summary, exposes report URLs, and can enforce a minimum EU AI Act compliance score.

> Release status: `v1.0.0` is the first stable release. Pin the full release
> commit SHA for maximum supply-chain assurance, or use `uti-blip/lexia-action@v1`
> to receive compatible v1 security fixes.

## Quick start

Create `LEXIA_API_TOKEN` and `LEXIA_WORKSPACE_ID` as GitHub Actions secrets. The repository must already be connected to that Lexia workspace.

```yaml
name: EU AI Act compliance

on:
  pull_request:
  push:
    branches: [main]
  schedule:
    - cron: "17 3 * * 1"

permissions: {}

jobs:
  lexia-audit:
    # Repository secrets are unavailable to Dependabot and fork pull requests.
    if: >-
      ${{
        github.actor != 'dependabot[bot]' &&
        (github.event_name != 'pull_request' ||
        github.event.pull_request.head.repo.full_name == github.repository)
      }}
    runs-on: ubuntu-latest
    steps:
      - name: Audit with Lexia
        id: lexia
        uses: uti-blip/lexia-action@v1
        with:
          api-token: ${{ secrets.LEXIA_API_TOKEN }}
          workspace-id: ${{ secrets.LEXIA_WORKSPACE_ID }}
          minimum-score: "80"
          fail-on: non-compliant

      - name: Show audit ID
        if: always()
        run: echo "Lexia audit ${{ steps.lexia.outputs.audit-id }}"
```

No checkout or `GITHUB_TOKEN` permission is required: Lexia scans the connected repository through its server-side GitHub integration. The action derives the pull-request head branch, full ref, head commit SHA, event, actor, workflow, job, repository ID, run ID/attempt, and pull-request number from the runner context. The scan is pinned to that immutable workflow commit; to audit another branch, run the workflow on that branch.

Dependabot runs and pull requests from forks are deliberately skipped because GitHub does not pass Actions secrets to those runs. Do not replace this guard with `pull_request_target` to expose the Lexia token to untrusted pull-request workflows.

## Inputs

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `api-token` | yes | — | Workspace-scoped token. Always pass through `${{ secrets… }}`. |
| `workspace-id` | yes | — | Workspace that owns the connected repository. |
| `api-url` | no | Lexia production | Official Lexia API URL. Only approved Lexia HTTPS hosts are accepted. |
| `wait-for-result` | no | `true` | Poll until `completed`, `failed`, or `cancelled`. |
| `timeout-minutes` | no | `20` | End-to-end deadline, from 1 to 120 minutes. |
| `poll-interval-seconds` | no | `5` | Polling cadence, from 2 to 60 seconds. |
| `minimum-score` | no | `80` | Accepted score, from 0 to 100. |
| `fail-on` | no | `non-compliant` | One of `non-compliant`, `audit-failure`, or `never`. |

Policy behavior:

- `non-compliant` fails when the audit fails/cancels, has no usable final score, or scores below `minimum-score`.
- `audit-failure` fails only when the audit fails, cancels, or times out; it ignores the score threshold.
- `never` keeps terminal audit failures and timeouts advisory. Invalid inputs, authentication errors, and failure to create an audit still fail the step so a missing audit cannot appear green.

Set `wait-for-result: "false"` for fire-and-follow-up workflows. In that mode, `conclusion` is `pending` and score gating is not performed.

## Outputs

| Output | Description |
| --- | --- |
| `audit-id` | Durable Lexia audit ID. |
| `status` | Final or last observed status. |
| `conclusion` | Policy conclusion: `success`, `failure`, or `pending`. |
| `compliance-score` | Final 0–100 score, if available. |
| `risk-level` | EU AI Act risk classification, if available. |
| `dashboard-url` | Lexia dashboard URL. |
| `json-report-url` | Authenticated JSON artifact endpoint. |
| `pdf-report-url` | Authenticated PDF artifact endpoint. |

Artifact endpoints require the same workspace Bearer token. They are intended
for a subsequent authenticated HTTP step; the job summary deliberately does
not render them as browser links. The dashboard URL remains directly clickable.

## Delivery and retry semantics

The action calls `POST /v1/ci/audits` with an `Authorization: Bearer` token and an `Idempotency-Key`. The key is a SHA-256 digest of the normalized workspace/repository/branch and GitHub run metadata. Repeating the same workflow run attempt replays the same audit; a GitHub rerun changes `run_attempt` and intentionally creates a new audit.

HTTP 429 and 5xx responses are retried at most four times. `Retry-After` is honored and capped at 30 seconds; other retries use capped exponential backoff. Response bodies are bounded to 1 MB and are never printed. Tokens are masked before any network operation.

## Development

This package requires Node.js 24.

```bash
npm ci
npm run build
npm run verify
```

`dist/index.js` is generated with `@vercel/ncc` and must be committed. `npm run check:dist` builds twice and compares byte-for-byte with the checked-in bundle. `npm run smoke:package` packs a clean archive and starts it without `node_modules`. `npm run audit:high` makes any high or critical advisory fail CI.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the release checklist and [SECURITY.md](SECURITY.md) for private vulnerability reporting.

## License

MIT — see [LICENSE](LICENSE).
