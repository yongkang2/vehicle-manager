# History Performance Implementation Plan

User-approved scope: optimize history loading on the original history feature branch, verify with synthetic data and regression tests, then open an English PR. Do not publish a release or replace v1.3.0 assets.

- Separate authorized local history reads from shared snapshot synchronization; keep existing background polling, membership checks, paused-sync and workspace isolation.
- Index vehicle/time history queries and reduce repeated label/options work. Preserve date boundaries, Chinese aliases, substring searches and exact filtered exports.
- Return lightweight summaries to the UI; fetch complete field differences only on expansion. Load global vehicle options separately.
- Keep same-filter content visible during background refresh; clearly distinguish changed-filter loading and retain cancellation protections.
- Benchmark 10,000 and 100,000 synthetic changes including large report snapshots. Measure list, vehicle/day filters, compound search, deep pages, details, response size and export.
- Run focused and full tests, lint, build, version consistency and final diff review before pushing and opening the PR.

Targets on the measured local fixture: first page and ordinary paging under one second, common compound searches under two seconds. Report actual results and hardware/environment scope rather than claiming real SMB latency.

Architecture: retain SQLite and current sync architecture; use derived local indexes, existing history filter semantics and existing workspace-scoped HTTP requests. No dependency or shared-protocol change.
