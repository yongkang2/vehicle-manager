---
version: alpha
colors:
  primary: '#243882'
  ink: '#172642'
  muted: '#58677d'
  line: '#dfe5ee'
  canvas: '#f3f6fa'
  surface: '#ffffff'
  navy: '#18274d'
  success: '#187760'
typography:
  body:
    fontFamily: 'Segoe UI, Microsoft YaHei UI, sans-serif'
    fontSize: 14px
    lineHeight: '1.6'
  data:
    fontFamily: 'Cascadia Code, Consolas, monospace'
    fontSize: 12px
rounded:
  control: 6px
  panel: 10px
spacing:
  page: 36px
  compactPage: 16px
components:
  navigation:
    width: 236px
  button:
    height: 40px
---
# Stellantis vehicle workspace

## Product scope and maintained evidence

Vehicle Manager is a local Windows engineering workspace for vehicle records, controller and battery configurations, DOVE reports, attachments, history and shared-folder collaboration. English and Chinese interfaces are supported. Preserve permissions, offline/sync recovery, confirmations, pagination, exports and existing workflows. Do not ship populated accounts or sample business databases.

The current checked-out **1.6.0 source is development work, not an official release**. Its compatibility target is local schema **6**, business protocols **1–5**, and new backup **format 5 / field version 4**, with readers for formats **1–4**. Real Windows SMB multi-computer acceptance remains a separate requirement.

Business and security evidence is maintained in the [development guide](developer-guide.md), [English user guide](portable-guide.en.md), API enforcement and shared domain types. API enforcement remains authoritative for authorization. This document consolidates the former root PRODUCT.md, DESIGN.md and UX-CONTRACT.md into one maintained source for product scope, visual design and interface behavior. Preserve the restrained, refined Stellantis-inspired direction; do not add production dependencies, remote fonts, decorative imagery or continuous animation for visual changes.

## Overview
Operate mode. Reference: https://www.stellantis.com/en . Deep blue navigation anchors a white, quietly structured engineering workspace. The approved direction is restraint and precision, not a marketing landing page.

## Colors
Canonical runtime values live in src/theme.ts; installThemeTokens maps the palette to root CSS variables before React renders, and App.tsx adapts the same palette to Ant Design. Refined.css owns the presentation layer. Existing specialized component styles remain in their owners.

## Typography
Local Windows fonts avoid font downloads and layout shifts. Semibold page titles, regular body text, tabular numerals, and monospace only for identifiers. Preserve Chinese font fallbacks.

## Layout
236px deep-blue navigation; 70px header; 36px desktop page inset. White table surface, subdued summary strip, left-aligned vehicle identity. At 1050px navigation contracts; at 700px navigation moves into document flow. Table overflow stays owned by the existing table primitive. Forms retain document scrolling.

## Elevation & Depth
Use hairline boundaries rather than decorative shadows or backdrop blur. Drawer headers use a cool tinted surface.

## Shapes
6px operational controls, 8px login controls, 10px operational panels, circular user avatar. No decorative cards or additional hero content in operational screens.

## Components

### Interface ownership and behavior

| Capability | Canonical owner | Source of truth | Allowed variants | Verification |
|---|---|---|---|---|
| Table selection | Ant Design Table + existing business selection | BusinessApp.tsx | existing report selection | project tests / browser |
| Select/Listbox | Ant Design Select | existing component usage | authored | keyboard / open popup |
| Date | Existing editor inputs and Ant Design DatePicker in history | RecordEditor.tsx / HistoryPanel.tsx | existing locale handling | project tests / browser |
| Form | Ant Design Form / RecordEditor | RecordEditor.tsx | create / edit | project tests |
| Scrollbar | Refined.css global baseline | this document | table geometry only | browser computed styles |
| Toast | AntApp message/modal | App.tsx | existing semantic tones | browser / project tests |
| CRUD | BusinessApp + RecordEditor + server API | developer-guide.md | existing save/close/refresh | project tests |

Preserve navigation, filters, table preferences and paging. Search clear and IME behavior remain with existing inputs. Existing loaders, inline errors, empty states, modal focus behavior and destructive confirmations remain owned by the library and business components. Product and API rules govern lifecycle and permission decisions. Follow the active English/Chinese interface language for new copy. Untouched workflow limitations do not imply full accessibility certification.
Ant Design owns controls, dialogs, drawers and notifications; Lucide owns icons. ResizableVehicleTable owns table sizing, filters, pagination and preferences. A centered single-column login restores the original entry composition. Its top anchor and reserved 64px bilingual title prevent content-height recentering during locale and login/register changes.

### Vehicle Modification behavior

Name the vehicle section **Vehicle Modification / 车辆改装**. Use **Start Date / 开始日期** and **Finish Date / 完成日期** for modification forms, retaining the existing stored date fields. Requestor and Lead are optional modification fields unlocked by activation of enhanced modifications; Onboard equipment remains separate. The dedicated section owns compact record rows, expanded fields/files, explicit Independent or Linked status and a review of every affected linked vehicle. Save a record before attaching files. Support at most **8 files per batch**, **10 MB per file**, and exactly `.doc`, `.docx`, `.txt`, `.xls`, `.xlsx`, `.pdf`, `.eml`, `.msg`, `.7z`, `.zip`; retain original names and bytes and show per-file outcomes.

Before upgrading, stop all old services and independently back up the complete shared folder and every local data directory, including originals. After all collaborating clients upgrade, an online administrator with explicitly resumed synchronization can choose **Enable enhanced modifications / 启用增强车辆改装**, with a reason, upgrading the business protocol to **5** and unlocking **Requestor, Lead, files and Linked mode together**. Before activation, Requestor and Lead inputs are disabled; basic modification names, descriptions and dates remain editable for records without enhanced values. Existing Requestor/Lead values and pending work are retained, while edits or copies carrying nonblank values, restoration of those values and queued publication carrying them are blocked until activation. Files and Linked mode also require activation. Protocol capability does not implicitly activate configuration revisions or review policies. Linked creation, editing, file changes, unlinking and lifecycle actions require connectivity and resumed synchronization; show the Personal workspace recovery path when paused. Eligible independent work keeps the established offline queue behavior.

Populate to vehicles searches existing eligible vehicles by partial VIN and requires explicit selection of **1–100 destination vehicles per action**, with no destinations preselected. Present One-time copy and Linked in one dialog, show selected vehicle/file counts and the affected shared scope, collect one reason and use one final Populate action. Copies contain independent current fields, dates and active files. Linked mode shares all fields, dates and files; edits from any member apply to every linked vehicle. Refresh stale reviews before submission; uncertain results retain the original action for retry or inspection.

Unlink freezes only this vehicle's current fields, dates and files as an independent copy. Archiving its modification or vehicle freezes an independent archived copy; restoring does not rejoin the group. Other vehicles remain linked. Permanent deletion removes the deleted vehicle's membership while preserving other vehicles' shared data and files. File archive/restore remains administrator-only. Product copy must explain the affected scope before the final action.

### Onboard equipment dates and attachments

Onboard equipment Add/Edit labels its Installed on and Removed on dates as optional in both languages; either or both may be blank. Name, Type and change reason are required for every manual Add/Edit save, including legacy records. Type has no default and uses exactly `ETAS tools`, `Basic Equipment`, `Charging Adaptors`, `Hook`, `Controller`, `Others`, stored separately as `data.equipmentType`. Legacy missing values remain readable and compatible with archive, restoration and server-verified removal-only updates; CSV, history, synchronization and backups preserve the value. Optional attachments are selected before one Save action: save the equipment first, then sequentially upload at most eight existing vehicle-attachment formats, 10 MB each. Retain saved equipment and successful files after partial failure, use request-bound save recovery and existing unknown-upload inspection, and never automatically recreate a saved equipment record while retrying files.

Read each selected file into an immutable byte snapshot immediately before transmission. Unreadable files require reselection and are not uncertain server saves. Stop unsent files on a transport failure and block further submission until explicit refresh/inspection; never automatically resend an uncertain file. Definite save validation errors remain editable, while invalid session/workspace and receipt mismatches block repeat submission and direct users to close, refresh/sign in and inspect equipment. Previously committed legacy receipts remain recoverable without enforcing a new field or creating duplicate records.

Use ordinary immutable attachment records with a server-managed equipment UUID reference. Expanded equipment details and the vehicle Attachments list expose the association and existing download/archive controls. Preserve links through rename, synchronization, backups and restoration. Archived equipment is read-only for new uploads; existing files remain retained. Cancelling before Save writes nothing; after Save retain committed work. Keep workspace cancellation, complete-workflow maintenance tracking and offline/paused operation without adding migrations or resuming synchronization.

## Do's and Don'ts
Keep feedback immediate. Hover transitions take 120ms; the login entrance takes 180ms. Reduced motion disables authored motion. Preserve lazy business/report loading and existing request caching. No animation timers, new production libraries, remote fonts, or extra business requests. Global visible scrollbars inherit palette; forced colors remains system-owned. Acceptance previews use isolated synthetic data; never expose real business data in screenshots or demo fixtures.

Refinement approved 2026-11-03: keep the operational structure; use Apple-like restraint in spacing and quiet surfaces. Remove the split login, preserve Stellantis branding, no new dependencies or motion.

History: HistoryPanel owns global and vehicle audit reading with scoped compound search and 50-entry pagination. Global history places vehicle, single local calendar day, keyword search and filtered export in one toolbar. Export uses exactly the current vehicle, local date and compound keywords across all matching pages; selecting a vehicle is optional. The button says Export filtered results. Export is disabled while filters are pending or no records match, and in-flight export is cancelled if filters change. Vehicle history has only date and keyword search, with no vehicle selector or export. Space-separated keywords match together across actor, reason, field names and contents, explained in concise bilingual help. Each compact summary separates actor, action and model-first vehicle/object context with actual flex gaps; quiet time aligns right on desktop, followed by a visible reason. One closed “View changes (N)” disclosure contains changed fields, source navigation and a quiet actor identifier; creation snapshots omit empty values and preserve zero/false. Filter state stays transient in existing view/tab navigation. Ant Design owns Select, DatePicker, inputs, tooltips and feedback; document scrolling remains natural.

## Business backup and recovery

Administrator-only backup actions distinguish a synchronized team backup (synchronization failures or pending/conflicting work block it) from a local working-copy backup (does not trigger synchronization). Review scope and synchronization state before downloading. ZIP names identify the team, source and UTC timestamp; manifests retain source revision/pending/conflict metadata.

Restore previews validate original files before enabling execution, show searchable record effects and field differences, and require one explicit acknowledgement for all archive candidates. Existing permanent-deletion and immutable-configuration rules remain authoritative. No selection-based partial restore is implied.

Managed modification restore publishes the reviewed group and memberships together under the shared lock. Compare-and-swap checks require the reviewed base states and shared group version to remain current. A conflict retains the unpublished payload and files rather than overwriting newer shared changes. Restore history offers Export retained payload and Retain and review again; the latter needs an online administrator, resumed synchronization and a reason, retains the attempt before refreshing canonical shared data, then requires a fresh preview. Retained payloads remain recoverable/exportable and are not silently replayed. Older readable backups cannot silently replace or detach current managed modifications.

Before application, save and read-back verify a business ZIP in the workspace data directory's `restore-backups/`. Retain these copies until an administrator manually removes them. They are local, unencrypted business snapshots, not independent disaster-recovery backups. Failure stops application. Durable request receipts commit atomically with the business transaction, distinguish unapplied/prepared, applied and published results, and prevent duplicate application. Administrators can inspect results and retry shared publication without reapplying a backup. Receipts and safety copies are local to the device/workspace. Shared publication retains the existing eventual-consistency and conflict behavior; successful publication does not prove every client has refreshed.

Backup menu: show only Back up data, Restore data, Restore history, without secondary descriptions. Explain the action in a brief dialog after clicking. JSON and local-only backup remain maintenance APIs, not normal menu actions.

Administrators in an online team overview check a shared lastBackupAt timestamp on entry and every minute. Remind when no timestamp is known or seven elapsed days (168 hours) have passed. Remind at most once per local calendar day per administrator on this device; dismissal persists in the workspace, not just browser memory. Reminder dismissal never blocks business work. Only completed team-backup HTTP transfers update the shared timestamp under the team lock; local exports, failed transfers and restore safety copies do not count. The timestamp cannot prove browser disk persistence. Offline/unverified status never triggers a stale team reminder. Team data must be writable to record completion; failure leaves the reminder eligible and records a local audit event.

History separation: horizontal dividers separate adjacent events only, with no trailing rule after the last event. Expanded differences are inset in a quiet tinted region with aligned Field/Before/After headings; field rows use whitespace rather than horizontal rules. Small containers hide the headings and stack each field label above its values.

History loading: show the authorized local history without waiting for shared snapshot or blob verification. Existing background synchronization supplies updates; display the last synchronized time without claiming the local view is necessarily current. Lists request compact summaries, and expanded entries fetch full differences on demand. Preserve visible entries and expanded state during same-filter background refresh; changed filters show an explicit loading state until their own results arrive. Global vehicle options load separately; vehicle-detail history omits this request. Exports retain the exact current filters across all matching pages and use the authorized local snapshot, like the displayed history.

History toolbar refinement: search guidance lives in a focusable help popover beside the search field, with its essential description retained for assistive technology. One quiet results row places the record count left and local/synchronization state right; the synchronization popover contains the complete timestamp and local-copy explanation. Pagination owns the page size/range copy. Vehicle options list current vehicle entities (including normally archived vehicles), excluding permanently deleted vehicles and nonvehicle configuration/catalog identifiers. Preserve all audit records, historical object labels, compound keyword search and filtered exports, including deleted-vehicle and configuration history.

## Application icon

The portable desktop shortcut and browser favicon use the silver flowing car mark on a solid midnight navy (#061850) rounded tile. The editable master is public/vehicle-manager.svg; PNG and multi-size ICO exports sit alongside it. The package includes Create-Desktop-Shortcut.cmd and vehicle-manager.ico; the shortcut targets Start.cmd in the extracted folder. Recreate it after moving or upgrading that folder.


Report archive: show active and archived reports together by default, with a model/VIN vehicle filter and compound search. Keep both controls at fixed desktop widths (320px and 400px), truncating long selected vehicle labels without resizing either control; stack at narrow widths. No acquisition-month selector. Space-separated terms match together across model, VIN, vehicle/project names, report names and dates. Archive state is indicated on each report without a separate filter. The archive list has no per-row action column; selected reports use a stable bulk action group. Keep selected count and the always-present clear-selection action on the left, and download/archive/compare on the right without shifting on selection. Vehicle-detail report lists and report-viewer actions retain their existing controls. Show model above VIN, preserve selection across pages and clear it when filters change. Selection has no two-report cap; download one original or a ZIP, archive selected active reports with one reason under existing administrator permissions, retaining failed selections. Compare exactly two unarchived reports of the same vehicle and associated VIN, older first; enforce archive exclusion on the server too. Emphasize acquisition time and filename for both baseline and compared report, and repeat their times above aligned field values. Read the authorized local snapshot without foreground shared synchronization. Open with loading feedback; default to differences only, show per-tab changed/total counts, and keep all details collapsed until requested. Reuse existing Ant Design controls, quiet surfaces and local fonts.
