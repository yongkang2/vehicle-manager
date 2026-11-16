# Lock scope and SQL paging implementation plan

**Goal:** Reduce contention and repeated vehicle filtering while preserving existing 1.9.1 data and shared-folder collaboration.

**Architecture:** Keep canonical merge/publication under the existing shared lease. Retain the local write guard and private snapshot through any deferred local ingestion. Use a disposable indexed SQLite query projection of the validated working view, without persistent schema or protocol changes.

**Scope:** Continue on `fix/sync-contention`. No production data, version change, package or release operation.

## Tasks

- [x] Add a deterministic regression proving another writer can acquire the shared lease during slow local refresh; preserve snapshot cleanup and error semantics.
- [x] Shorten only the ordinary synchronization path; leave maintenance callers' locked contracts intact. Validate old/new synchronization, pending work, history and originals.
- [x] Move vehicle filtering/count/paging into indexed SQL with bound values, preserving JavaScript search normalization, row order, facets, details and cross-page relationships.
- [x] Exercise cache rebuilds and query parity on synthetic datasets. Report cold/warm costs without implying removal of full working-view validation.
- [x] Run full tests, build, lint, version checks, the three-client virtual usage audit and the existing baseline 1.9.1 upgrade harness.
- [x] Review final diff and record virtual measurements and limitations. Physical SMB and actual business-copy acceptance remain outstanding.

## Acceptance

No shared/local persistent format changes, no weakened publication exclusion, no lost pending work, no query semantic drift. Performance results must distinguish total duration from shared-lock occupancy and include the cost of rebuilding the SQL projection.
