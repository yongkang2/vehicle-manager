# History loading performance plan

**Goal:** Reduce history first-page, pagination and filtered-query work without changing search/date/export semantics or weakening live access checks.
**Base:** origin/main 9d1f7a6 (released 1.7.0). Work is isolated on history-loading-performance.

- [x] Measure the released implementation and inspect SQLite plans before changing production queries.
- [x] Add regressions for stable same-timestamp paging, index ordering/reopening and query correctness. Keep substring/Chinese alias/history-label/date-offset semantics.
- [x] Remove avoidable joins and fix indexed ordering if confirmed; keep exact counts, 50-item pages and lazy detail.
- [x] Inspect history refresh invalidation without reintroducing full audit payloads; implement only a reliable lightweight fix if needed.
- [x] Compare like-for-like indexed summary benchmarks, run history/compatibility tests, full tests/lint/build and independent review.

Constraints: Preserve auth and shared-roster checks, local-first history reads, original audit data, exports, deletion rules and workspace isolation. No external search service or dependency. No release/publication in this task. Real SMB/browser latency must not be inferred from local synthetic timings.

Validation: final full suite 529 passed, 2 skipped, 0 failed (531 total). Lint, build and version consistency passed; existing training-script lint and Vite chunk-size warnings remain. Independent review found no remaining actionable findings. Paired 100,000-change synthetic queries: first page 132 to 2 ms, page 2 135 to 1 ms, page 100 299 to 1 ms. Detailed results and measurement limits are in docs/benchmarks/history-performance.md.

Ruling: User identified first open/pagination as the main issue. Keep current exact substring search and live permission checks; no result cache or frontend redesign. Use lazily created local history revision metadata so the existing exact-data migration guards remain intact. Preserve and rerun original migration tests rather than relax them. INSERT OR IGNORE replay, transaction rollback, updates/deletes and reopened stores are covered. No formal package or Release is produced by this task.
