# Changelog

All notable changes follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and semantic versioning.

## [Unreleased]

### Added

- Node 24 TypeScript action with an autonomous `ncc` bundle.
- Durable v1 audit creation and polling contract.
- Deterministic per-workflow-attempt idempotency.
- Configurable timeout, polling cadence, compliance threshold, and gate policy.
- Job summary plus audit, score, risk, dashboard, JSON, and PDF outputs.
- Bounded 429/5xx retries with `Retry-After` support.
- Contract, policy, clean-package, bundle reproducibility, and security gates.

## [1.0.0] - 2026-08-21

First stable public release of the durable Lexia audit action.
