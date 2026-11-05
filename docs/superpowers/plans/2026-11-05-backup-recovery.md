# Backup recovery implementation plan

**Goal:** Make administrator business backup and same-team recovery verifiable and traceable.
**Architecture:** Reuse existing backup formats, maintenance lock and local transactions. Validate without applying, save verified safety ZIPs, and commit durable request receipts with business changes.
**Tech Stack:** TypeScript, SQLite, Express, React, Ant Design; no new dependencies.
**Spec:** User-approved proposal in this chat, 2026-11-05; consolidated behavior in docs/design.md.

## Constraints
Preserve deletion markers, immutable configuration history and existing admin checks. Do not change application or storage versions. Preserve unrelated working changes. Safety copies are local business snapshots, not independent disaster recovery.

## Tasks
- [x] Add regression tests for preview integrity, metadata, safety copies, transactional receipts and duplicate requests; observe failures.
- [x] Share restore validation with preview; add detailed effects and source metadata.
- [x] Add verified safety copies and durable administrator request receipts; support result inspection and safe publication retry.
- [x] Separate synchronized team backup from local working-copy backup; reject unavailable synchronization for the former.
- [x] Update bilingual recovery UI with searchable effects, one archive acknowledgement and persistent results.
- [x] Update guides and design source; run full tests, lint, build and version checks.

## Review focus
Interrupted responses must not duplicate restore. Corrupt originals must fail before any business write. Preview changes must invalidate execution. Revoked administrators must not access backup or receipts. Safety-copy failure must prevent application.

## Validation
Full suite: 407 tests, 405 passed, 2 skipped, 0 failed. Build, lint (four existing training-script warnings) and version consistency passed. Isolated browser smoke covered backup-scope confirmation, upload/preview, confirmation, recovery and published receipt. Independent review findings about unsafe metadata, pending-import counts, normalized effects and async download errors were fixed; backend regressions observed failing and then passing. ZIP packaging/release and real multi-computer SMB fault testing are outside this source-change validation.

## Accepted follow-up
Keep only Back up data, Restore data and Restore history as single-line menu actions. Provide concise explanation after clicking. Record completed team-backup transfers in shared team metadata under the existing lock. Remind online administrators after seven elapsed days or when no backup is recorded, with local per-administrator calendar-day dismissal. Local backups, failed transfers and restore safety snapshots do not reset the timer. Check reminder eligibility again after asynchronous reads and suppress it during active backup/restore flows. Browser smoke confirmed the simplified menu and persistent same-day suppression. These changes do not publish a release or alter database/shared-business/backup formats.
