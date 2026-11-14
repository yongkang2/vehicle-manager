# Vehicle list paging and detail loading

**Goal:** Reduce whole-workspace browser loading while preserving 1.9.1 business data, table filters/preferences, statistics, modification scope and complete exports.

**Architecture:** Add an opt-in authorized server query; keep existing full workspace/delta contracts. Reuse one validated working view per local revision, filter/page on the server, and deliver only page summaries plus explicitly requested detail dependencies. No data migration, schema/shared/backup protocol change, new production dependency or visual redesign.

## Completed

- [x] Extract canonical filter keys and existing report/controller selection into shared/vehicle-table-values.ts. Frontend formatting remains bilingual; all 15 existing filter tests pass.
- [x] Add server/vehicle-list.ts with one bounded revision cache, validated queries, whole-fleet counts, whole eligible-fleet facets, page bounds and compact summary records.
- [x] Add POST /vehicle-list with a bounded JSON query body (and compatible GET form) under the existing access/session/workspace middleware. Warm-cache reads reject revoked users. Existing /workspace and export endpoints remain intact.
- [x] Extend WorkspaceLoader with opt-in page queries; no whole-workspace delta baseline is reused for paged results. Existing generation/cancellation protection remains.
- [x] Wire ResizableVehicleTable/BusinessApp to remote totals/pages/facets, retaining column preferences, explicit loading, empty/error recovery and locale formatting.
- [x] Load complete vehicle details and report contents on request; gate detail actions until complete data is present.
- [x] Preserve cross-page linked modification scope and populate targets using lightweight whole-fleet identities and relevant group memberships. A failing regression exposed the missing second linked vehicle; the fixed regression also verifies an off-page destination and group version.
- [x] Load CSV data separately from the current list page. Existing dialog selection/template/export owners remain; refreshing CSV does not overwrite page records.
- [x] Extend the isolated three-client/1,000-vehicle/5,000-equipment audit to verify summary size, page 100, full counts and requested detail equipment.
- [x] Build, lint, version checks, upgrade check, focused tests and full frozen-source suite pass.

## Owners

- shared/vehicle-list.ts: request/page metadata contracts.
- shared/vehicle-table-values.ts: language-independent canonical filter values and report/controller selection.
- server/vehicle-list.ts: revision-scoped projection, filtering, page selection and detail dependencies.
- server/business-routes.ts: authorization and additive HTTP endpoint.
- src/workspace-loader.ts: scoped asynchronous page requests.
- src/ResizableVehicleTable.tsx: remote table paging/facets with existing controls.
- src/BusinessApp.tsx: page/detail/report/export workflow integration.
- docs/design.md: maintained interface behavior; no new root design files.

## Evidence

- Full suite: 626 total, 624 passed, 2 skipped, 0 failed (120906 ms). Build/lint/check:version pass. Existing five lint warnings and large-bundle warning remain; no new lint warnings.
- Three-client local load audit passed: 1,000 vehicles, 5,000 equipment, 6,001 history events. Old full workspace response 2,027,536–2,027,545 bytes; new 10-vehicle summary 113,158–146,356 bytes including global facets and sync metadata. Cold HTTP page reads 102–105 ms versus full view 112–119 ms in this run. This is a local synthetic sample, not SMB acceptance or a production percentile guarantee.
- Final 1.9.1 source upgrade check: 314 records, 323 history entries, pending edit, archives/deletion markers, DOVE originals, configuration history, linked/independent modifications and old-backup restore/reopen passed. Baseline is tag-matching source commit 6f9354ac76e7999e9a115ad6aa95417366f01a0a, not an installed-package test.
- Isolated built browser preview (12 vehicles): second page has two rows while fleet count stays 12; owner-column filtering finds four vehicles across pages; text filtering resets paging; no matches shows zero rows with whole-fleet totals retained.
- CSV from a filtered list still shows 12/12 selectable vehicles across its own pages. Vehicle equipment and latest parsed DOVE report open on demand. Keyboard Enter opens a column filter; Escape dismisses it.
- Injected HTTP 503 with authentic workspace headers retains prior data and exposes Retry loading; removing the fault and retrying recovers the filtered result. An initial headerless injected response correctly triggered the existing workspace-change protection and was not considered the intended error test.
- English 1440x1000 and Chinese 390x844 inspected; existing document/table overflow ownership preserved. Screenshots retained under output/vehicle-paging-*.png. Automated UI detection returned no findings. The only browser console errors were the intentionally injected HTTP 503 responses.
- Independent review found missing cross-page modification context; corrected with a failing/passing regression. A suspected list-row archive issue was withdrawn: list actions only open details, and drawer actions wait for full context.

## Limits and remaining work

Server paging currently uses the complete validated local view on revision changes; SQL-scoped filtering/index work remains conditional on profiling, not claimed complete. Facets necessarily include values across the eligible fleet. One selected vehicle loads its full working graph, rather than separate HTTP calls per detail tab. Reports/DOVE/global history retain their established owners and loading behavior. Shared lock splitting, actual business-data-copy/physical SMB/installed-package acceptance and formal release remain separate work. No production data, release tag, ZIP or minimum-version gate was changed. Work is being prepared for a PR on fix/sync-contention; final commit and candidate provenance are recorded by the packaging workflow.

Final pre-PR review found long Chinese filter values can overflow Node HTTP request-line limits. VehicleList requests now use POST JSON; the server treats them as read-only, preserves local/full semantics and never triggers mutation-finish synchronization. Loader and HTTP regressions cover a 4,000-character Chinese notes filter.
