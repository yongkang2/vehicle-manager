# Shared-folder synchronization performance plan

**Goal:** Reduce multi-client waiting while preserving direct use of existing 1.9.1 shared and local data.

**Architecture:** Keep local SQLite, filesystem leases, immutable snapshots and atomic shared publication. Prefer read-only no-change checks and per-cycle reuse; do not change schema, shared protocols, backup formats or the minimum-client gate.

**Scope:** First delivery plus the second-batch local-ingestion improvements authorized on 2026-11-13. No production data access, release publication or production ZIP. Source version is now 1.10.0 for candidate acceptance; the official release remains 1.9.1 until separately published.

## Execution ledger

- [x] Reproduce unchanged background polling waiting on another client's lock: regression returned busy after the existing three-second wait.
- [x] Move the existing verified, unchanged-HEAD shortcut ahead of lock acquisition. Check live access before and after HEAD; recheck local queues after asynchronous reads. Full/manual sync, changed HEAD, conflicts, pending work, expired verification and failed ingestion retain the canonical locked path.
- [x] Deduplicate successful immutable blob transfers within one publication only; never carry this cache into another cycle.
- [x] Record lock-wait and callback-through-release timing in local diagnostics. Preserve only allowlisted numeric stage values. The prior diagnostic writer silently discarded stage timings.
- [x] Add actual 25–35 second timer jitter after the service tick settles. Browser workspace checks and the service tick share bounded busy backoff; successful checks impose no extra deadline. Manual synchronization does not consult the backoff timer.
- [x] Run isolated 1.9.1 source-to-source compatibility verification, focused regressions, full tests, lint, build and version consistency.
- [ ] Validate a representative authorized business-data copy and physical Windows SMB clients before release.
- [ ] Evaluate broader lock-scope reduction after measuring actual lock-held stages on SMB.
- [x] Later delivery: server-side list paging/detail loading with selection/export/UI acceptance; see [third-batch ledger](2026-11-13-vehicle-list-loading.md). SQL-scoped query/index optimization remains conditional on profiling.

Ruling: Work on a dedicated branch in the current checkout, preserving the existing untracked output directory. No worktree or production directory operations are necessary for these source changes.

Ruling: Keep publication and local ingestion inside the existing lease for this delivery. Moving them outside needs a proven snapshot-lifetime and local-write reconciliation contract. The read-only shortcut removes unnecessary contention without changing writer exclusion. Physical SMB evidence is unavailable; do not claim broader lock changes or production acceptance.

Ruling: Do not add new UI state or rewrite GET behavior in this delivery. Existing local-first workspace/history/revision reads remain; unchanged workspace refreshes now avoid the lock through the shared synchronization owner.

## First-batch validation evidence (historical)

- `npx tsx --test test/sync-refresh.test.ts test/diagnostics.test.ts test/sync-poll.test.ts`: 11 passed.
- `npm test`: 623 total, 621 passed, 2 skipped, 0 failed.
- Final frozen-source rerun: 623 total, 621 passed, 2 skipped, 0 failed, 104249 ms. A preceding run overlapped a transient incomplete edit/build and failed three startup tests; it was not accepted. The syntax and listen-error scheduling path were fixed before the frozen rerun.
- `npm run build`, `npm run lint`, `npm run check:version`: passed. Existing five lint warnings and Vite large-chunk warning remain.
- `npx tsx scripts/verify-sync-upgrade.ts`: extracts only server/shared/package.json from baseline commit `6f9354ac76e7999e9a115ad6aa95417366f01a0a` (source version 1.9.1) into a temporary test directory. Creates a synthetic team with a vehicle, attachment, history and pending local edit, closes the old store, opens it with current code, verifies content/history/pending/original bytes and unchanged shared HEAD on open, publishes, then reopens/synchronizes with baseline code.
- Local contention sample: baseline unchanged check while another client holds the lock returned busy in 3015 ms; updated check returned ready in 3 ms. One synthetic local-directory sample, not an SMB capacity or latency guarantee.
- Repeat during validation: 3030 ms/busy versus 9 ms/ready; no production-performance claim. Independent review identified fixed-grid jitter, browser-backoff bypass and listen-error rescheduling; all three were corrected. HTTP regression checks browser/tick backoff and manual bypass.

## Release gates and recovery

Before publication, compare real release provenance and the actual 1.9.1 package, verify an authorized representative data copy (including configuration revisions, linked modifications, archives and backup/restore), and test multiple physical SMB clients. Run normal release checks from clean traceable source, advance the app version and produce the unique ZIP with SHA-256. Stop clients and independently preserve the entire shared folder and each local data directory before rollout. A rollback after new writes must preserve/reconcile those writes; never blindly restore the old backup.

## Second batch: ingestion and expanded upgrade acceptance

- [x] Reproduce per-record statement preparation: 32 vehicles compiled the same local lookup 32 times. Regression now requires one lookup preparation per ingestion and exact history equality.
- [x] Prepare record lookup/insert/update statements once per ingestion. Prepare history insertion once per canonical acceptance, and remove the redundant third history insertion loop.
- [x] Parse one record view per validation boundary and reuse it across read-only configuration/modification/equipment validators and file-reference collection. Do not reuse across mutations or synchronization cycles.
- [x] Expand the real baseline-source fixture using existing public business services: archived vehicle, equipment/file association, independent and linked modifications/files, custom component catalog, published configuration, parsed DOVE report/controller, permanent deletion marker, pending edit and old-backup restoration.
- [x] Verify baseline commit matches local `v1.9.1^{commit}`: `6f9354ac76e7999e9a115ad6aa95417366f01a0a`.
- [x] Frozen production source: full suite 624 total, 622 passed, 2 skipped, 0 failed (118420 ms); focused sync/modification/revision/restore suites 43 passed before the final full run. Build, lint and version check passed, with the same existing warnings. Independent review found no additional correctness/data-loss issue.
- [x] Standalone expanded check: 314 records, 323 history entries, one preserved pending edit; original attachment/report bytes, linked membership, archive and deletion state, configuration history, old-backup restore, new-backup preview and baseline-code reopen passed.
- [x] Standalone five-sample full-sync profile: baseline median 66 ms, updated median 22 ms; unchanged check under another owner's lock 3009 ms/busy versus 1 ms/ready. See [measurement scope](../../benchmarks/sync-contention-2026-11-13.md).
- [ ] Representative real business-data copy and physical multi-computer SMB acceptance: requires a dedicated test share and test devices; requested from the user. No production data was opened.

Ruling: Measured local refresh/acceptance overhead justifies removing repeated preparation and parsing. Keep the publication lock boundary unchanged: this already reduces time spent under it without introducing a new shared transaction protocol. Broader lock splitting remains conditional on representative SMB measurements.
