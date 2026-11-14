# User feedback and multi-client usage audit

## Remediation follow-up

The four requested fixes are implemented on the same unreleased branch. The sections after this follow-up preserve the original audit, not the current implementation status. Application version, local schema version and shared business protocols are unchanged; new local triggers/indexes and optional HTTP response fields are derived/runtime behavior, not a shared-format upgrade.

### Implemented behavior

- Initial workspace failure has a persistent error and Retry loading action, with no fabricated zero totals. A failed refresh retains the last successful data, filters and selection and identifies it as previously loaded data. Successful retry clears the error.
- Workspace clients explicitly opt into `delta=1`. Known baselines receive changed/new records, removed IDs and current configuration/history metadata; missing/expired baselines and larger-than-full patches fall back to complete snapshots. A bounded two-revision cache per view avoids repeated construction on unchanged reads. Local SQLite triggers invalidate on records, history, deletion markers, quarantined operations and relevant configuration changes; authorization still runs before cache access. Audit views are rebuilt to preserve current identity resolution.
- Sync applies at most 128 record groups per transaction in its private unpublished SQLite snapshot and writes at most eight independent immutable operation files concurrently. Every file retains checksum verification, flush and pre-rename lease verification. All in-flight file writes settle before a failure is propagated. Final shared publication is still atomic; conflicts, permissions, receipts, pending changes and original bytes remain protected.
- Sync status exposes operation/record counts, five stages and stage timings; the sync page polls status only during active work. Progress is cleared on success and failure. Diagnostic records retain stage timings without adding them to business backups or shared snapshots.
- History uses an incrementally refreshed temporary search projection keyed by event row ID, compound conditions in one pass and one materialized match set for count/paging. Original nested-key/value, literal punctuation, Chinese alias, hidden-metadata and historical-vehicle matching remains authoritative. Append updates extend the projection; updates/deletions rebuild it. A full trigram FTS trial was rejected because cold initialization was too expensive. No full-text dependency or persistent search database was shipped.
- HTTP history queries execute in a bounded-queue background process with a consistent read transaction. The process detaches the business database after each query and exits before application databases close. Session, workspace and membership are rechecked before a result is returned. Exports retain the existing streaming owner and matching filters.

### Follow-up measurements

Same synthetic fleet and commands as the original audit. Runs were executed without a simultaneous build for the final measurements. Hardware/load variability remains; these are observations, not p95 or SMB guarantees.

| Scenario | Original observation | Follow-up observation |
| --- | --- | --- |
| Publish 6,000 pending records | 38,869 ms | 21,484 ms |
| Unchanged workspace HTTP read | 73-107 ms; 248 bytes | 10-22 ms; 336-344 bytes, including new timing metadata |
| Workspace transport after one owner-field change | 2,027,476 bytes | 3,155-3,156 bytes |
| 100,000-entry compound search, prepared projection | 1,021 ms | 232 ms |
| 100,000-entry DOVE search, prepared projection | 1,630 ms | 121 ms |
| Background compound query, warm process/projection | Not measured | 229 ms |
| Background compound query, cold process/projection | Not measured | 1,983 ms |
| Main-process timer gap during background queries | Not measured | Maximum 26 ms; 133 samples at a requested 10 ms interval |

The final 100,000-entry direct projection initialization was 1,049 ms, reported separately. Other prepared queries: first page 108 ms, page 2 116 ms, page 100 121 ms, one vehicle 30 ms, day filter 352 ms, one-vehicle export 89 ms. The same run's immutable v1.7.0 baseline was 2,007 ms for compound search and 1,530 ms for DOVE; do not confuse this historical comparison with the original 1.8.0 audit values above.

The final fleet run's stage times were opening 1,644 ms, immutable operation files 13,236 ms, applying records 2,794 ms, publication 376 ms and local refresh 3,366 ms. New client initial synchronization remained 5,190-5,578 ms in that run. Full synchronization after one field change remained 2,361-2,997 ms: reducing HTTP workspace bytes does not eliminate canonical snapshot/blob verification. First full workspace delivery remains about 2 MB; per-vehicle lazy loading is not claimed. Operation-file durability and full synchronization cost remain follow-up profiling targets, not removed safeguards.

The normal first history page also incurs background-process startup once per workspace/process lifetime. Search projection initialization is still a cold cost, not hidden in the warm numbers. Timer-gap measurement demonstrates parent event-loop availability in this fixture, not end-to-end concurrent HTTP latency or an accessibility SLA.

### Verification

- Full suite: 618 tests, 616 passed, 2 skipped, 0 failed on the standalone rerun. An earlier run concurrent with build had one `SHARE_ACCESS_DENIED` in an existing team-lock test; its 12-test standalone suite and the complete standalone rerun passed without changing lock code or relaxing assertions.
- After final progress cleanup and control-character handling, focused sync/restore and history suites each passed all 9 tests. Final build passed. Final lint has only the four pre-existing training-script warnings; the existing main-bundle size warning remains.
- A 260-record, multi-transaction publication failure retains all pending work, exposes the publication stage and retries without duplicate records/history. Existing lease-loss, receipt, equipment-link, original-byte, deletion and restore tests pass.
- Async history returning after member revocation is rejected with HTTP 403. Cache/delta tests cover unchanged construction, opt-in versus full clients, scope isolation, removed records and stale-baseline recovery. Search tests include control characters, quote/backslash/percent literals, Unicode case semantics, aliases, append/update/delete and export completeness.
- Real built UI at 1440x1000: injected initial workspace failure showed a persistent error/retry and no fleet totals; reconnecting restored all 12 preview vehicles. Injected later refresh failure kept all totals and the `Nova` filter; retry cleared the warning without losing data.
- Chinese 390x844: the refresh warning was 348px wide inside the viewport, retry remained reachable and the filter remained `Nova`. Reduced motion was enabled for stable measurements.
- A controlled sync-status response showed `Saving change files / 正在保存变更文件` with `128 / 6000`; completion removed progress. This validates presentation only; real progress and durability are covered by the bulk test above. The real background HTTP history endpoint returned 51 retained events with 50-entry paging.
- Final synthetic preview: `http://127.0.0.1:64287`, with the documented preview-only credentials. No production data was opened. Physical Windows/SMB acceptance, high-volume browser rendering and representative report/blob capacity remain unverified.

## Scope and provenance

- Date: 2026-11-11. Branch: `feature/friendly-feedback-usage-audit`.
- Source baseline: `6cb466146fbd589bd39aca751f8ff0d678636769`, plus the uncommitted changes on this branch. Source/build version: 1.8.0. No release, package, commit or merge was performed.
- One Windows host, Node.js 24.21.0, three application instances with separate databases, device identities, accounts and sessions, sharing one synthetic local directory. This is not three physical computers or Windows SMB acceptance.
- Only synthetic temporary data was used. The existing application data directory and existing service on port 4426 were not modified or stopped. The load script cleans up its own instances and directory; the UI preview retains its isolated temporary directory for inspection.
- Timings are observed single-run local baselines, not p95 measurements, production capacity guarantees or network-share predictions. History benchmarks and the initial build were run concurrently; use repeated isolated runs for performance acceptance.

## Changes implemented

The shared English/Chinese error catalog now explains recovery for interrupted saves, shared-folder access/busy states, version conflicts, account access, corrupted/missing files and data-version mismatches. Network and unknown errors ask users to inspect saved results before resubmitting instead of blindly retrying. Workspace-change copy no longer promises that every earlier operation was unapplied and reminds users to copy unsaved text before reloading.

Photo validation, local safety-backup failure, invalid local schema, backup modification conflicts and configuration-policy activation now have specific messages instead of the generic fallback. Shared locks are described in ordinary terms without inviting manual deletion. No authorization, lock, retry, receipt, synchronization or database semantics changed.

Error toasts remain keyed by error code and now stay for eight seconds. The workspace-change warning separates its short title from recovery instructions and offers `Keep page open` / `暂不刷新` so users can copy unsaved text before reloading. Existing stale-request guards remain authoritative. The backup reminder says `Dismiss for today` / `今天不再提醒`, matching the existing local-calendar-day dismissal behavior. Destructive confirmations remain in place.

The preview accepts `VEHICLE_MANAGER_PREVIEW_PORT`, including `0` for an automatically assigned free port. `scripts/audit-usage.ts` adds reproducible large-workspace verification without production dependencies.

## Measurements

### Three clients, 1,000 vehicles and 5,000 equipment records

Command: `npx tsx scripts/audit-usage.ts`.

Data generation uses real domain writes, not UI/API bulk-create performance. Synchronization and workspace reads use real HTTP endpoints. The script uses a new HTTP connection per request to avoid stale keep-alive sockets across synchronous fixture generation; this does not represent browser connection reuse. It does not seed reports or large attachment blobs at this scale.

| Scenario | Observed result |
| --- | --- |
| Generate 6,000 records and pending operations | 6,580 ms |
| First client publishes 6,000 pending operations | 38,869 ms |
| Second / third client initial synchronization | 1,177 / 1,089 ms |
| Local workspace HTTP reads, including JSON parsing | 90-106 ms; 2,027,450 bytes |
| Unchanged local workspace reads | 73-107 ms; 248 bytes |
| Other clients synchronize one changed owner field | 585-639 ms |
| Workspace returned after that one-field change | 2,027,476 bytes |
| History summary, 6,001 entries | 17 ms; 50 items; 28,403 bytes |

Assertions passed: all clients had exactly 6,000 records, initial queues drained, the changed owner reached both other clients without conflicts, and all 6,001 history events remained available with 50-entry paging.

Harness development failures were not counted as passes: the first two runs hit an expired Node fetch keep-alive connection after synchronous fixture generation; the next run reached the final check but used the wrong history URL. The final complete run above passed without automatic request retries.

### History scale

Command: `npx tsx scripts/benchmark-history.ts`. Existing benchmark: 1,000 vehicles, 10,000 / 100,000 synthetic history entries, including oversized report-like content. Current implementation results:

| Query | 10,000 entries | 100,000 entries |
| --- | --- | --- |
| First page | 17 ms | 102 ms |
| Second page | 13 ms | 106 ms |
| Page 100 | 21 ms | 112 ms |
| One vehicle | 5 ms | 21 ms |
| One calendar day | 40 ms | 343 ms |
| Compound keywords | 107 ms | 1,021 ms |
| DOVE keyword | 167 ms | 1,630 ms |
| One-vehicle export | 20 ms | 111 ms |

The 100,000-entry first-page summary was 18,049 bytes. The one-vehicle export covers 100 events, not an export of all 100,000 entries. The benchmark also prints historical v1.7.0 comparisons; those are not release acceptance results.

## Prioritized remediation

P1 means a priority for the next engineering work, not a confirmed data-loss incident. No data loss was observed in the exercised scenarios.

| Priority | Finding and evidence | Proposed change | Acceptance criterion |
| --- | --- | --- | --- |
| P1 | First publication took 38.9 seconds for 6,000 queued writes. `server/sync.ts` writes immutable operation files sequentially and applies per-record transactions. Those paths are investigation candidates, not profiled proof of the entire cost. | Profile file flush, transaction and snapshot phases; expose meaningful progress and pending counts. Evaluate bounded batching without removing durable writes, request receipts, lease checks or conflict isolation. | Repeat at least five times, record p50/p95 and phase timings; show progress promptly; recover correctly from failure before/after publication and lease loss. Establish the timing budget on representative SMB hardware before optimizing. |
| P1 | After an injected workspace-read failure and a locale remount, the vehicle page showed zero totals/empty content with only a transient error. Reloading after reconnection restored all 12 vehicles. This is ambiguous presentation, not deletion. | Keep an explicit load-error state, distinguish unavailable from genuinely empty, retain the last successful snapshot where possible, and offer a named retry action. | Both languages show loading/empty/error distinctly; injected failure never claims zero vehicles as an authoritative result; retry restores the previous filters and selection. |
| P1 | One owner-field change caused the approximately 2 MB complete workspace to be returned again. Unchanged reads still took 73-107 ms. `server/business-routes.ts` constructs and hashes the complete working view before checking the known revision. | Use transaction-owned revision invalidation, lightweight vehicle summaries and lazy detail loading; consider incremental transport after measuring. Preserve local-first reads, authorization and workspace isolation. | Unchanged requests do not rebuild all business data; one-field updates do not require a complete fleet payload. Repeat with mixed reports/files and assert history, configuration and deletion cache invalidation. |
| P2 | At 100,000 events, keyword searches took 1.0-1.6 seconds. `server/history.ts` searches nested JSON and counts all matches synchronously. | Profile queries; evaluate an indexed search projection and bounded worker execution. Keep compound terms, escaped literal search, historical vehicle labels, hidden metadata search and exports consistent. | Record p95 and concurrent health/request latency, not just query time. Suggested local target: under 500 ms for representative searches, subject to agreed hardware; preserve exact result IDs and counts. |
| P2 | Final build warned about the 1,142.61 kB main JS chunk (368.05 kB gzip). The separate business chunk is 429.12 kB (130.05 kB gzip). | Analyze bundle ownership and split optional heavy workflows. Keep one theme provider and existing lazy boundaries; avoid adding dependencies solely for visual feedback. | Compare cold/warm startup on representative devices and a throttled browser. No extra business requests, blank loading surfaces, locale layout shifts or runtime import failures. |
| P2 | New guidance is clearer, but an eight-second toast still disappears and offers no persistent inspection or support reference. Unsaved-text recovery is manual. | Add persistent workflow-owned errors for uncertain saves, retained drafts where appropriate, and a copyable diagnostic/request reference outside the primary plain-language message. Do not equate every generic failure with a confirmed rejection. | Lost-response tests never auto-resend an uncertain upload or recreate committed records. Keyboard users can reach recovery actions; messages remain usable in both locales and narrow layouts. |
| Deployment gate | Local multi-instance tests cannot establish SMB lease behavior, latency, disk-full handling, endpoint permissions, physical device failures or simultaneous mixed-version deployment safety. Files are not encrypted by the app; revocation cannot erase offline copies. | Perform the physical-device matrix below and use approved disk/share access and independent backups. Do not present the filesystem lease as arbitrary-partition fencing or local safety copies as disaster-recovery backups. | Record actual machines, app versions, SMB server, network conditions, source/package checksums, restored bytes and recoverability before production sign-off. |

## Functional and visual verification

- Existing focused suites: 50 passed. Scenarios include two-client different-field merge, same-field conflict and explicit resolution, retained offline edits, independent process synchronization, shared-head rollback detection, administrator restrictions, deletion/quarantine and receipt replay, exact original-file bytes, backup restoration and stopped/restarted publication recovery.
- Full suite before the last catalog additions: 612 tests, 610 passed, 2 skipped, 0 failed. Final catalog/workspace-request/workspace-switch regression: 28 passed, including all three catalog tests. The two skipped tests are not claimed as exercised acceptance.
- Final build passed. Final lint passed with four existing warnings in `vehicle-manager-training/production`; the bundle-size warning remains as recorded above. Editor diagnostics reported no errors in the changed TypeScript files.
- Actual built UI: invalid-password error and successful preview login; login-to-vehicle-heading approximately 454 ms in one warm local run. Twelve synthetic vehicles, reports, attachments and configuration history were initialized. This is not a 1,000-vehicle browser rendering measurement.
- Desktop 1440x1000 and narrow 390x844: inspected the Add vehicle form, required-field errors, English/Chinese switching, cancel/Escape behavior, network-error presentation and reduced motion. The primary add button retained identical locale bounds (140x40); the background heading retained identical bounds before/during/after its modal.
- At 390px, the Chinese form measured approximately 374px wide and stayed inside the viewport; its footer remained visible. Stable network feedback measured approximately 342x94px at y=8 with the complete recovery text. An earlier negative-y sample occurred during entrance motion, not at rest. The screenshot and geometry check do not establish full accessibility certification or every overlay's correctness.
- The network-read fault was browser-injected only. Reconnection and reload restored all 12 vehicles. No real network, shared directory or business database was disrupted.
- Final built UI recovery check: a browser-injected `WORKSPACE_CHANGED` rejection during a completed vehicle form opened the warning. `Keep page open` dismissed it and preserved the exact unsaved nickname. The request was intercepted before reaching the server; actual stale-token enforcement is covered by the workspace regression tests, not inferred from that mock.

## Required physical-device follow-up

1. Use at least three Windows machines with separate approved accounts/device identities on one real SMB share. Never copy a local database/device identity between machines. Back up the entire share and every local data directory first.
2. Measure warm/cold startup, paging, search, one-field saves, report parsing, attachment download and synchronization with the representative fleet, report history and original-file sizes. Record client responsiveness and p50/p95, not only server timings.
3. Edit the same/different fields concurrently; disconnect one client, edit eligible independent records, reconnect and inspect conflicts. Cover linked modifications, configuration publication, permission revocation and explicitly paused synchronization.
4. Interrupt a process before/after shared publication and during file upload. Verify lease recovery, unchanged request receipts, no duplicate saves, retained uncertain uploads and exact attachment checksums after retry/inspection.
5. Test read-only shares, missing permissions, low disk space, interrupted restore, independent backup restoration and mixed-version refusal in disposable fixtures. Never delete active locks, overwrite published packages or use real production data for fault injection.

## Reproduction

```powershell
npx tsx scripts/audit-usage.ts
npx tsx scripts/benchmark-history.ts
npx tsx --test test/i18n.test.ts
npm test
npm run lint
npm run build
```

For UI review, run `npm run preview:ui`. If its default port is occupied, set `VEHICLE_MANAGER_PREVIEW_PORT` to a free port, or `0`, before starting it; use the actual URL printed by the script. Only the explicit preview creates demo credentials.