# Shared data compatibility implementation plan

Goal: support existing protocol 1/2/3 without data loss, preserve UI, reject future protocols safely, release 1.2.1.
Approved design: the compatibility and release safeguards described in this conversation.

- [x] Create isolated fix/shared-data-version-compatibility branch from latest main.
- [x] Reuse canonical protocol 3 validation, immutable records, synchronization and backup preservation. Do not expose configuration authoring APIs or automatically upgrade shared protocol.
- [x] Test old/future formats, no mutation on rejection, protocol monotonicity and backup round trip; inspect supplied archive only in private temporary copies.
- [x] Run full tests, lint, build and independent review.
- [x] Gate packaging on compatibility tests and final extracted portable workflow.
- [ ] Create and merge PR; publish versioned final ZIP and checksum after downloaded artifact verification.

Constraints: no new production dependencies; original archive and shared folder untouched. Retain local schema4 and accept structurally identical schema5 databases without rewriting their version.
Review focus: protected revision records, team version gates, pending operations, deleted vehicles, backup receipts.
