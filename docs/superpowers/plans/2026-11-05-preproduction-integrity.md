# Preproduction Integrity Fixes Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Fix the four findings approved after the read-only production audit, then open an English PR.

**Architecture:** Preserve the existing SQLite outbox, shared snapshot and restore authorization boundaries. Add a durable local history-import queue only where ordinary restore operations cannot carry recovered history; publish under the existing shared lock and acknowledge after canonical ingestion.

**Tech Stack:** TypeScript, Node.js SQLite, Express, node:test/tsx.

**Spec:** User-approved audit findings in this conversation; existing contracts in docs/developer-guide.md and docs/releases.md.

## Global Constraints

- No unrelated cleanup, dependency changes, data migration, version bump or release publication.
- Preserve existing user edits and all administrator, immutable-record and deletion protections.
- English commit subjects, PR title, PR description and packaged instructions.

## Review Focus

- Missing legacy keys must survive restore and sync; concurrent changes must conflict.
- Both local and shared conflict choices must preserve missing-key semantics.
- History-only restore must remain pending across publication failure and process restart.
- Revoked administrators must not publish restored history; repeat synchronization must not duplicate it.
- Upload completion must reject expired sessions, revoked membership and changed workspace epochs.

### Task 1: Restore field removal

Files: server/sync.ts; test/restore-sync-integrity.test.ts.

- [x] Add failing restore-to-two-client regression and concurrent removal conflict tests for local/shared choices.
- [x] Run with `npx tsx --test test/restore-sync-integrity.test.ts` and observe the missing-key failure.
- [x] Compare base/desired key unions in conflict detection, application and resolution; preserve blank equivalence.
- [x] Run the focused regression successfully.

### Task 2: History-only publication

Files: server/backup.ts, server/sync.ts, shared/business.ts; test/restore-sync-integrity.test.ts.

- [x] Add failing offline edit/revert backup restore test with unchanged current records.
- [x] Queue historical imports durably, include them in pending status and restore admission checks, and publish with fresh admin/device authorization.
- [x] Clear imports only after canonical acknowledgement; preserve original change attribution and immutable records.
- [x] Verify publication retry/restart, revoked administrator, third-client visibility and idempotency.

### Task 3: Attachment authorization

Files: server/business-routes.ts; test/attachment-batch-api.test.ts.

- [x] Add delayed-blob tests that invalidate the session, membership and workspace epoch before the final write; observe failures.
- [x] Reuse finalAccess immediately before business.write and use its actor.
- [x] Run the attachment API regressions successfully.

### Task 4: Packaged instructions and delivery

Files: scripts/package.mjs; existing English portable guide for reference.

- [x] Correct the packaged README default data path and override instructions to match the resolver and guide.
- [x] Run the complete test suite, lint, build, version check and whitespace check; review the final diff.
- [x] Obtain independent review and verify the scoped diff before commit. Delivery: push the repair branch and create/attach an English PR.
- [x] Report remaining real-SMB/manual acceptance and release work without claiming either completed.

## Validation record

- Full suite: 418 tests, 416 passed, 2 skipped external DOVE samples, 0 failed.
- Build, version consistency, rendered English package instructions and whitespace checks passed.
- Lint: no errors; four existing warnings in training scripts.
- Independent scoped review: no actionable P1/P2 findings.
- Existing fixture assumptions updated to acknowledge pending recovered history and reject cancelled uploads.
- Real multi-computer SMB acceptance, final ZIP acceptance and release publication remain separate delivery gates.
