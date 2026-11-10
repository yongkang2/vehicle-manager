# Shared loading performance implementation plan

**Goal:** Reduce SMB-dependent viewing latency without weakening access, integrity, deletion or publication checks.
**Architecture:** Authorized local revision reads, SQL-scoped record reads, no unused audit payload in workspace refreshes, stable photo identity. Preserve original files and no-store responses. No schema, protocol or backup changes.
**Execution:** Inline; user requested implementation directly. Base: main afd3574. Unrelated UI work remains in its original checkout.

- [x] Add regression coverage: revision viewing skips synchronization but rejects revoked access; workspace reads do not load unused history.
- [x] Implement local revision reads; keep preview, publication and explicit full refresh authoritative. Reuse one records snapshot per revision query; retain full integrity validation.
- [x] Push optional record filters into parameterized SQL; retain deletion filtering and ordering.
- [x] Remove unused workspace history arrays and stabilize photo component identity without a persistent cache.
- [x] Run targeted tests, full suite, lint, build and version checks; inspect final diff.

Security: Every read still checks team membership. Photo bytes retain hash and format validation and final permission checks. No TTL-based permission cache, no original deletion, no relaxed write/version checks. Local reads can show last synchronized revisions; existing refresh remains the explicit full check.

Deferred: persistent image caching, thumbnail generation and incremental synchronization require real SMB measurements to justify their added invalidation/storage complexity.

Validation: 2026-11-10, npm test: 518 passed, 2 skipped, 0 failed (520 total). npm run lint, npm run build and npm run check:version passed. Existing training-script lint warnings and Vite chunk-size warning remain. Revision regression confirms zero synchronization calls for local list/detail, one for explicit refresh, and denial after membership revocation. Real Windows SMB end-to-end latency remains unmeasured.

Ruling: Retain full configuration validation on reads rather than introduce an integrity cache before measuring; this trades some local CPU for simpler corruption detection. Remove the unused workspace history field and update internal consumers/tests; durable history remains accessible through its dedicated APIs.
