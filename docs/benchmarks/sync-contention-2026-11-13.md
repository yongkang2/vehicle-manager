# Synchronization and 1.9.1 upgrade verification

Date: 2026-11-13. Unreleased work on `fix/sync-contention`.

## Scope

`npx tsx scripts/verify-sync-upgrade.ts` extracts server/shared sources and package metadata from commit `6f9354ac76e7999e9a115ad6aa95417366f01a0a`, matching the local v1.9.1 tag. Baseline code creates synthetic data in a temporary directory under test/, closes the store, and current code opens the same local data and shared directory. Baseline code subsequently reopens and synchronizes the upgraded data. This verifies source compatibility, not the installed ZIP, representative company data or physical SMB behavior.

The final fixture contains 314 retained records and 323 pre-upgrade history entries: three retained vehicles including an archived vehicle, 301 equipment records, ordinary/equipment-associated original files, independent and linked modifications and files, a custom component type, a published configuration, a parsed XLSX DOVE report and controller. A fourth vehicle is permanently deleted through the baseline service, preserving its canonical marker. One later local vehicle edit remains pending at upgrade.

Assertions compare complete local records/history, pending count, deletion markers and original bytes on opening; shared HEAD must remain byte-identical on open. After publishing the pending edit, an old backup is previewed/restored and synchronized, protected configuration and linked membership remain readable, report originals and deletion markers remain intact, and a new backup previews without conflict. Old code then reopens and synchronizes the result. Test directories are removed after stores close.

## Measurements

One standalone run after the full test suite, with five sequential full synchronization samples per implementation. All full-sync samples have no pending publication. The old samples precede a single owner edit; new samples follow publication of that edit, so the new snapshot includes one additional history entry. Runs are sequential, not randomized; filesystem warming and normal hardware variability may affect timings. These are small synthetic full-check measurements, not bulk-write or production percentile guarantees.

| Measurement | Baseline 1.9.1 source | Updated source |
| --- | --- | --- |
| Full-sync samples, ms | 66, 73, 64, 60, 74 | 27, 22, 21, 21, 23 |
| Full-sync median, ms | 66 | 22 |
| Opening-stage median, ms | 24 | 12 |
| Local-refresh-stage median, ms | 36 | 8 |
| Unchanged background check while another owner holds the lock | 3009 ms, busy | 1 ms, ready |

Opening includes canonical acceptance; repeated history statement compilation therefore affects it as well as final ingestion. The implementation reuses local prepared statements, avoids an unnecessary third history-copy loop, and shares parsed record views within read-only validation boundaries. It retains canonical acceptance, checksums, integrity checks, conflict handling, lease verification and atomic HEAD publication. No database schema, shared protocol, backup format or minimum-client gate changed.

## Regression and release status

- Full suite: 624 total, 622 passed, 2 skipped, 0 failed.
- Build, lint and version consistency passed; existing lint and bundle-size warnings remain.
- A targeted regression verifies one prepared record lookup for a 32-vehicle ingest and exact equality of retained history.
- Existing sync, managed modification, configuration/backup and restore tests exercise publication failure/retry, conflicts and retained payloads.
- No release, tag movement, production ZIP or production-data operation was performed. Physical SMB, real-data-copy and installed-package acceptance remain release gates.
