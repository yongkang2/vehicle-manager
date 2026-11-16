# Lock scope and SQL paging virtual acceptance

Date: 2026-11-16. Working tree on `fix/sync-contention`; not a released build.

## Changes and boundaries

Ordinary sync releases the publication lease before local ingestion from its retained private SQLite snapshot. The local write guard remains held. Publication exclusion and maintenance workflows are unchanged. Access is checked before ingestion and before success. Release failures still dispose the snapshot; retry acknowledges already published work normally. A later concurrent publication is observed on the next sync, not included retroactively in the private snapshot.

Vehicle queries use a disposable indexed SQLite projection in memory. Bound SQL applies filters, match counts and LIMIT/OFFSET. Facets and fleet counts are cached per revision. Complete validated working views and associated-record scans remain; this is not a fully database-scoped working view. No persistent schema, shared protocol, backup format or minimum-client changes.

## Verification

- Full suite: 632 tests, 630 passed, 2 skipped, no failures/cancellations. Build, lint and version checks passed, with the existing five lint warnings and bundle-size warning.
- Deterministic concurrent-ingestion tests: another client acquires the lease and publishes while the first is paused reading an uncached original. Pending work, original bytes and history remain intact. Revocation returns ACCESS_DISABLED; simulated lease-release failure cleans the private snapshot and retries safely. The old implementation fails these concurrency cases with SHARE_BUSY after about 3.17 seconds.
- SQL regressions retain global facets/counts, last-page clamping, detail/linked scope, Unicode and literal substring search, NUL/surrogate behavior, 20,000-value selections, null/revised cache stamps and rebuild/disposal behavior.
- Independent source review found no remaining blocking issue. Initial concurrent verification overlapped the implementer's intentional old-code red check; only the frozen-source passing runs above are accepted.

## Virtual usage audit

`npx tsx scripts/audit-usage.ts`: three independent clients, 1,000 vehicles, 5,000 equipment records, one local shared directory. All assertions passed: initial synchronization, bounded pages, detail lookup, editing, propagation, incremental refresh and 6,001 history entries.

| Client | Full workspace | Cold summary page | Summary bytes |
| --- | --- | --- | --- |
| Administrator | 162 ms / 2,027,544 bytes | 126 ms | 146,355 |
| Engineer | 128 ms / 2,027,536 bytes | 90 ms | 110,623 |
| Reviewer | 114 ms / 2,027,536 bytes | 85 ms | 110,623 |

Single-change receiving synchronization: 355 ms and 278 ms. These single samples are functional local measurements, not percentile or SMB guarantees. Page payload reduction also includes the earlier summary-loading implementation; do not attribute all of it to this SQL change.

## Query microbenchmark

`npx tsx scripts/verify-vehicle-query.ts`: 10,000 synthetic vehicles, 5 warmups and 30 measured reads. Cold SQL projection construction: 250.97 ms. Previous JavaScript filter/facet work: median 20.31 ms, p95 22.20 ms. New full page response: median 1.09 ms, p95 1.54 ms. The baseline measures filter/facet work rather than the entire previous response. Both use the same cached validated view; view construction is excluded. The new cold cost is real and repeated whenever the revision changes. Frequent writes or infrequent reads can reduce or reverse the benefit; indexes also consume memory. These measurements do not justify claiming all list opens are faster.

## 1.9.1 compatibility

`npx tsx scripts/verify-sync-upgrade.ts`: baseline source `6f9354ac76e7999e9a115ad6aa95417366f01a0a`, 314 records and 323 retained history entries. One pending edit, original bytes, configuration and linked modifications survived; opening left shared HEAD unchanged; old backup restore and baseline-code reopen passed. This run is source-to-source compatibility, not a newly packaged executable acceptance.

The older 1.9.1 comparison reported full-sync medians 73 ms versus 22 ms and unchanged checks under another owner's lock 3,030 ms/busy versus 2 ms/ready. These include the previous optimization batches and are not an isolated measurement of the new lock deferral.

## Outstanding scope

Synthetic data on one Windows host only. Physical SMB, real business-data copies and actual new portable-package acceptance remain untested. Production data was not opened. No version was advanced, no package generated, and no publication performed.
