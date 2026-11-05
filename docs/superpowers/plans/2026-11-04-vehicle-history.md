# Vehicle History Implementation Plan

Goal: readable attribution, complete paginated vehicle history, full-history search and one-click Excel export.

Approved scope (latest manual feedback): existing vehicle History tab and global History view; compact actor/action/vehicle-object/time summary with deliberate spacing and visible reason, all field differences collapsed by default. Suppress meaningless empty creation fields and de-emphasize technical IDs. Vehicle labels prefer model then VIN. Global toolbar: vehicle, local calendar day, compound keyword search and filtered export. Single-vehicle toolbar: only date and compound search, no vehicle selector or export. Remove the object-type selector. Space-separated keywords match together across actor/reason/field names/contents, with clear bilingual examples and common Chinese field aliases. Keep the fleet list unchanged. Retain 50-entry server paging and search all persisted history. Export exactly the current vehicle/date/compound-search matches across all pages; vehicle selection is optional. No business-schema/protocol changes.

Contract: GET /api/business/history/query?vehicleId=&kind=&date=YYYY-MM-DD&offset=browserTimezoneOffset&q=&page= returns {items,total,page,pageSize,vehicleOptions}, pageSize=50; each item includes vehicleLabel. Date boundaries follow the browser's local calendar day. GET /api/business/history/export uses the same vehicle/date/offset/endOffset/q filters as the query and returns an English-header XLSX of all matching history, ignoring page. Existing history APIs remain compatible.

- Implement backend queries and export with regression coverage beyond 1000 entries, vehicle isolation, old values and missing/deleted fields.
- Implement a shared HistoryPanel with scoped requests, bilingual labels, visible differences, independent pagination and loading/error states. Reuse in vehicle/global history.
- Generate an isolated manual acceptance instance with synthetic users, multiple vehicles, over 1200 changes, old serial numbers and bulk changes. Keep real data untouched.
- Run tests, lint and build; review and inspect the preview. Provide local URL, credentials and acceptance steps.
- Manual acceptance completed: the user explicitly approved PR submission on 2026-11-05 after reviewing the synthetic preview and corrected filtered export. PR creation is authorized; merging and releasing are outside this step.

Validation: 394 tests passed, 2 skipped, 0 failed; production build, lint and version consistency passed. Existing lint warnings are confined to training scripts. Independent review found no material issues. Browser and downloaded-workbook verification confirmed a combined vehicle/date/keyword filter returning one change exports that same change; automated tests also cover all 65 matching records across pages, historical identity lookup, local-day boundaries, removed fields and oversized Excel cell content.
