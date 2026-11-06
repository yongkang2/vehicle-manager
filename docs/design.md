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

## Do's and Don'ts
Keep feedback immediate. Hover transitions take 120ms; the login entrance takes 180ms. Reduced motion disables authored motion. Preserve lazy business/report loading and existing request caching. No animation timers, new production libraries, remote fonts, or extra business requests. Global visible scrollbars inherit palette; forced colors remains system-owned. Acceptance previews use isolated synthetic data; never expose real business data in screenshots or demo fixtures.

Refinement approved 2026-11-03: keep the operational structure; use Apple-like restraint in spacing and quiet surfaces. Remove the split login, preserve Stellantis branding, no new dependencies or motion.

History: HistoryPanel owns global and vehicle audit reading with scoped compound search and 50-entry pagination. Global history places vehicle, single local calendar day, keyword search and filtered export in one toolbar. Export uses exactly the current vehicle, local date and compound keywords across all matching pages; selecting a vehicle is optional. The button says Export filtered results. Export is disabled while filters are pending or no records match, and in-flight export is cancelled if filters change. Vehicle history has only date and keyword search, with no vehicle selector or export. Space-separated keywords match together across actor, reason, field names and contents, explained in concise bilingual help. Each compact summary separates actor, action and model-first vehicle/object context with actual flex gaps; quiet time aligns right on desktop, followed by a visible reason. One closed “View changes (N)” disclosure contains changed fields, source navigation and a quiet actor identifier; creation snapshots omit empty values and preserve zero/false. Filter state stays transient in existing view/tab navigation. Ant Design owns Select, DatePicker, inputs, tooltips and feedback; document scrolling remains natural.

## Business backup and recovery

Administrator-only backup actions distinguish a synchronized team backup (synchronization failures or pending/conflicting work block it) from a local working-copy backup (does not trigger synchronization). Review scope and synchronization state before downloading. ZIP names identify the team, source and UTC timestamp; manifests retain source revision/pending/conflict metadata.

Restore previews validate original files before enabling execution, show searchable record effects and field differences, and require one explicit acknowledgement for all archive candidates. Existing permanent-deletion and immutable-configuration rules remain authoritative. No selection-based partial restore is implied.

Before application, save and read-back verify a business ZIP in the workspace data directory's `restore-backups/`. Retain these copies until an administrator manually removes them. They are local, unencrypted business snapshots, not independent disaster-recovery backups. Failure stops application. Durable request receipts commit atomically with the business transaction, distinguish unapplied/prepared, applied and published results, and prevent duplicate application. Administrators can inspect results and retry shared publication without reapplying a backup. Receipts and safety copies are local to the device/workspace. Shared publication retains the existing eventual-consistency and conflict behavior; successful publication does not prove every client has refreshed.

Backup menu: show only Back up data, Restore data, Restore history, without secondary descriptions. Explain the action in a brief dialog after clicking. JSON and local-only backup remain maintenance APIs, not normal menu actions.

Administrators in an online team overview check a shared lastBackupAt timestamp on entry and every minute. Remind when no timestamp is known or seven elapsed days (168 hours) have passed. Remind at most once per local calendar day per administrator on this device; dismissal persists in the workspace, not just browser memory. Reminder dismissal never blocks business work. Only completed team-backup HTTP transfers update the shared timestamp under the team lock; local exports, failed transfers and restore safety copies do not count. The timestamp cannot prove browser disk persistence. Offline/unverified status never triggers a stale team reminder. Team data must be writable to record completion; failure leaves the reminder eligible and records a local audit event.

History separation: horizontal dividers separate adjacent events only, with no trailing rule after the last event. Expanded differences are inset in a quiet tinted region with aligned Field/Before/After headings; field rows use whitespace rather than horizontal rules. Small containers hide the headings and stack each field label above its values.

History loading: show the authorized local history without waiting for shared snapshot or blob verification. Existing background synchronization supplies updates; display the last synchronized time without claiming the local view is necessarily current. Lists request compact summaries, and expanded entries fetch full differences on demand. Preserve visible entries and expanded state during same-filter background refresh; changed filters show an explicit loading state until their own results arrive. Global vehicle options load separately; vehicle-detail history omits this request. Exports retain the exact current filters across all matching pages and use the authorized local snapshot, like the displayed history.
