# Security policy

## Reporting a vulnerability

Do not open a public issue for suspected vulnerabilities, leaked credentials, authentication bypasses, or cross-workspace data exposure. Use the **Report a vulnerability** button in the Security tab of the canonical `uti-blip/lexia-action` repository so maintainers receive a private security advisory.

Include the affected version or commit, impact, reproduction steps, and any suggested mitigation. Do not include real Lexia API tokens, customer repository content, or compliance reports. If the private advisory channel is unavailable, contact Lexia through the authenticated support channel in the product.

## Supported versions

The latest `v1` release receives security fixes. Consumers that require immutable supply-chain references should pin the full release commit SHA and use Dependabot for updates.

## Security properties

- The workspace token is masked before network activity and is never included in outputs or summaries.
- Only credential-free HTTPS URLs on approved Lexia API hosts are accepted.
- Audit creation uses deterministic idempotency and workspace-scoped bearer authentication.
- Response bodies are size-bounded and never logged on failure.
- HTTP retries are bounded; polling has an end-to-end deadline.
- GitHub Enterprise Server is rejected until the backend supports it explicitly.
