# Contributing

## Local verification

Use Node.js 24 and npm from the lockfile:

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run verify
```

Source changes and their generated `dist/index.js` update belong in the same pull request. Never edit `dist/index.js` by hand. Tests use native Node HTTP primitives and mocked `fetch`; they must not call production services or use real tokens.

## Pull-request requirements

1. Add or update a test for every contract or policy change.
2. Keep the action metadata, README inputs/outputs, backend v1 contract, and frontend workflow snippet aligned.
3. Confirm `npm run check:dist`, `npm run smoke:package`, and `npm run audit:high` pass from a clean checkout.
4. Do not log response bodies, tokens, workspace secrets, or report content.
5. Record user-visible changes in `CHANGELOG.md`.

## Release procedure

1. Run the full verification suite on Node 24.
2. Canary the exact commit SHA in a private repository connected to a non-production test workspace.
3. Verify idempotent replay, a successful result, a below-threshold result, a worker failure, and a timeout.
4. Create immutable release `v1.0.0` from the verified commit.
5. Move the signed major alias `v1` to that release commit.
6. Publish or update the GitHub Marketplace listing only after the license owner, branding, support channel, and Marketplace Developer Agreement are approved.

Never move an immutable `v1.0.0` tag. Patch fixes become a new semantic version; update `v1` only after the same canary gates pass.
