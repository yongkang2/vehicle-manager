# Report archive management

Approved approach: vehicle-filtered table with unrestricted selection, batch download/archive and focused comparison.

1. Preserve current permissions and workspace boundaries. Add report ZIP download with validated IDs and unique safe filenames; reuse archive API with one reason and retain failed selections.
2. Display model and VIN, vehicle selector, report-name search and archive status. Keep selection across pages, reset on filters.
3. Compare authorized local snapshots without foreground sync. Return report metadata plus differences. Default to differences, collapsed rows, aligned field values and counts.
4. Verify comparison semantics, ZIP validation, build, lint and full tests. Update docs/design.md. No release or version changes.

User testing refinement: show all reports by default without archive filtering; exclude archived reports from comparison on both client and server. Use compound keyword search across vehicle identity, project, report and dates, plus an acquisition-month filter. Strengthen comparison identity with prominent acquisition time and filename and repeat acquisition times over field values. Verify the existing sandbox with September/October/November samples.
