# STELLANTIS Vehicle Data Management

Version 0.2.0, integrated business build. React + TypeScript + Ant Design, Node.js 24 + Express, local SQLite.

## Current Scope

This independent application now includes the agreed vehicle business workflows. Real company Windows/SMB acceptance is still required before production deployment. The existing `vehicle-demo` and `dove-import-preview` are not modified.

Implemented: local registration/login, English default with Chinese selection, persisted language choice, deferred shared-folder setup, read/write/rename checks, explicit team creation, join requests, administrator approval/rejection, existing-identity device binding, role changes, account disablement, device revocation and last-effective-administrator protection. Team management always reads the live shared roster under an exclusive lock; credentials and login sessions remain local. Team rollback detection is also applied before management writes.

Also implemented: vehicle CRUD; structured controller/motor/battery parts; modification and equipment records; installation/removal dates; authenticated attachments; field-level change history; admin-only archiving and restoration; shared business snapshots and conflict handling; DOVE preview/VIN matching/original retention; same-VIN controller and fault comparison; explicitly selected configuration updates with report provenance; JSON export; admin backup and forward restore; local security audit; portable Windows x64 packaging. No vehicles, reports or accounts are seeded.

Not claimed: arbitrary DOVE template compatibility, fault occurrence statistics, automatic diagnosis/release decisions, tamper-proof authorization, automatic disaster recovery, password recovery, scheduled independent backups, instant offline revocation or company endpoint/SMB approval. Original-file storage is private but not encrypted by this application; use approved disk/share protection.

## Build and Run

```powershell
npm ci
npm run build
npm start
```

Open http://127.0.0.1:4410 . The application listens on the local loopback address only. Change `PORT` if this port is occupied. Local data defaults to this project's `data/`; set `VEHICLE_MANAGER_DATA_DIR` to choose another dedicated local directory. The old Demo's 4310 port is not used.

Double-click `Start.cmd` to start in the background and open the browser. It reuses the service for this data directory, or chooses a free local port. The service checks open application pages every five minutes and stops gracefully once none remain, with a short reconnect grace period for refresh/navigation. Closing one tab does not stop a service still used by another app tab; hidden, minimized or inactive pages remain connected. A server with no app page opened also stops after the initial five-minute check. Reopen the application with `Start.cmd` after an automatic stop. `Stop.cmd` still verifies the same instance and requests an immediate clean stop; it does not kill unrelated Node.js processes. Pending synchronization settles before the local database closes; offline changes remain queued on disk. The launcher and `npm start` should not be used concurrently for the same data directory. Local `service.json` contains a stop-control secret; do not share it or `data/`.

For development, run `npm run dev:server` and `npm run dev` in separate terminals. Vite uses 4411 and proxies API requests to 4410.

## First Launch and Shared Path

1. Create a local account; passwords must be 10–128 characters. There are no default credentials.
2. If the company share is not ready, choose **Set up later**. The path remains unconfigured; no simulated share is silently connected and no remote root is created.
3. Once the share exists, enter a UNC path such as `\\fileserver\team\vehicle-data` and test the connection. The signed-in Windows account must already have SMB/NTFS access. The application does not ask for or store Windows credentials.
4. An existing, empty, dedicated folder may explicitly initialize a team after confirmation. The current account becomes the first administrator. A directory containing another application's files, including the previous Demo's snapshots, is not overwritten or adopted automatically.
5. For an existing team, submit a join request. An approved administrator must verify the person/device and choose a new member identity or bind it to an existing identity. The first local account on another computer is not automatically an administrator.
6. The selected path is persisted in the local SQLite settings. Re-entering a path is required only for a fresh installation or an intentional relocation; another team's ID is rejected.

The share contains a versioned `team.json` roster and a transient `.vehicle-manager-team-lock/` directory during writes. Approved clients additionally maintain `business/HEAD.json`, immutable `business/snapshots/`, unique `business/operations/` and content-addressed `business/blobs/`. Team and business writes use the same exclusive lock. SQLite merge work is performed on a local temporary copy, not by multiple clients writing a network SQLite WAL. Do not edit shared protocol files manually. A stranded lock requires confirming that every client has stopped and preserving a backup before manual maintenance; locks are never reclaimed merely because they look old. Real SMB behavior still needs multi-computer validation.

Pending or disabled accounts cannot access the administrator API. Offline status may display the last approved cached identity, but all administrator operations require a successful live shared-folder read. People who can modify the share or local SQLite can bypass normal application controls; this is not tamper-proof enterprise authentication. Copy application code to another computer, not `data/`, session files or another device's identity.

## Business Use

- Approved users enter **Vehicles** by default. Add a real vehicle, then use its detail drawer for parts, modifications, equipment, reports, attachments and history. Project code is separate from model. Serial numbers are text. Parts contains one fixed VCU, MCU and BMS/MSB per vehicle, without add/install/remove controls. Existing historical records are not deleted.
- **DOVE import** accepts up to eight supported `.xlsx` files in one batch, each up to 10 MB. Matched uploads open an explicit confirmation dialog showing the VIN, current values and all twelve fields for VCU, MCU and BMS/MSB. Only confirmation saves the report and applies valid controller data in one local transaction; cancelling writes nothing. Source conflicts require selection and older reports require acknowledgement. Configuration import is enabled by default and can be disabled for report-only retention. Duplicate originals reuse the report but can reapply configuration after fresh confirmation. Missing and invalid values preserve current data. Preview expires after 30 minutes; at most eight drafts and two parsers are allowed. Parsing runs sequentially within a batch in a child process with a 20-second deadline and 256 MB V8 heap per file, plus ZIP/worksheet limits. These limits are not a promise to accept every workbook under 10 MB.
- **Reports** supports original download and same-VIN two-report comparison. Duplicate byte-identical originals are deduplicated. Differences do not establish repair, correct software or vehicle release. No fault occurrence/trend analysis is performed.
- **Overview** shows vehicle details only. **Parts** displays name, supplier, product part number, software part number and calibration version for the three fixed controllers; **More** opens the twelve-field editor. The controller name is fixed, other fields can be edited manually, and a change reason is required. Cancelling writes nothing; saving checks the record version and records history. Empty fixed slots can also be filled here without adding duplicate controllers. EVCU maps to VCU; BMS and MSB map to BMS/MSB without altering the original report. **Update vehicle configuration** remains available for selecting a retained VIN-matched report, controller and individual fields, with source selection and older-report confirmation where required.
- **Shared sync** shows pending operations, conflicts and errors. Reads try synchronization first; successful local writes trigger synchronization; the running service retries every 30 seconds. Offline saves remain queued. Shared publication is eventual consistency, not a guarantee that every client updates within 30 seconds.
- Conflicting fields require local/shared choices. Duplicate VIN or an unavailable parent cannot be forced over a canonical shared record. Administrators can review blocked authorization conflicts, and the latest roster governs subsequent submissions. Do not copy a full local database over the shared snapshot.
- **Change history** contains synchronized business changes with actor/device/reason/source. **Device audit log** is administrator-only and displays this computer's login/download/export/backup events; it is not an immutable central security log.

## Backup and Restore

Administrators can download an unencrypted ZIP containing records, synchronized history, pending operation payloads, referenced original blobs and a team-roster snapshot. It excludes local passwords and login sessions. Current safety limits are 200 MB total ZIP/expanded content, a 20 MB manifest and 10 MB per blob. Monitor disk capacity; old shared snapshots are retained and not automatically purged. A share snapshot is not a backup in a separate failure domain.

Restore is an online administrator operation: pause other clients and writes, independently preserve the current entire shared directory and local data, finish existing pending operations, select a backup from the same team, type `RESTORE`, and enter a reason. The application records forward business changes rather than rolling the shared sequence backwards; records outside the backup are archived, not physically deleted. New business changes after the backup may be replaced, so do not restore while others continue editing. Archived vehicles and retained originals are supported. Validate the restored records, history and files and then resume clients.

The roster in the ZIP is preserved for manual identity/disaster investigation; the ordinary business restore UI does not roll back roles, reinstate revoked devices, replace local accounts or silently replay arbitrary historical pending-operation payloads. It restores the backup's record state through newly authorized operations. Lost roster/administrator credentials or incompatible/rolled-back protocol state require a coordinated manual recovery using independently preserved complete data, not pointing `HEAD.json` to an old snapshot and forcing clients onward.

## Portable Distribution

```powershell
npm run package:portable
```

On Windows x64 this builds a timestamped clean folder and ZIP under `releases/`, including `runtime/node.exe`, its license, runtime dependency licenses, built application, `Start.cmd`, `Stop.cmd` and a short guide. No local database, accounts, test reports or shared path are included. Extract to a writable local folder and double-click `Start.cmd`. Do not run from inside the ZIP or install the application into the team share. Each colleague registers and points to the same existing team.

Package smoke verification uses an isolated directory:

```powershell
node scripts/smoke-portable.mjs "releases\<generated-folder>"
```

It checks the bundled Node runtime, launch reuse, vehicle entry, isolated parser, byte-identical originals, backup and graceful stop. Enterprise application control can still block a portable runtime; obtain IT approval rather than trying to evade policy. Stop and back up before upgrading. Never copy another user's `data/` to initialize a new device.

## Verification

```powershell
npm test
npm run lint
npm run build
```

Tests use temporary directories under `test/`, never the existing Demo data. They cover setup/identity, business validation and atomic history/queues, dual-client and independent-process sync, conflicts/offline/replay/rollback, isolated DOVE parsing, two known real templates when available, exact original bytes, configuration updates, report archive/restore, and end-to-end backup restoration including archived vehicles. Optional real samples are never copied into a release. Browser acceptance has additionally exercised manual vehicle/part entry, report retention/update/comparison, cross-client member access and English/Chinese at desktop and 320/390-pixel widths.

The known templates' historical expected controller/fault record counts are 54/89 and 39/56. They belong to different VINs; same-vehicle comparison tests use explicitly synthetic test workbooks instead of pretending the real samples form a before/after pair. ExcelJS's transitive UUID dependency is pinned to a compatible patched version; rerun tests and dependency audit after updates. Vite still reports a large main component-library chunk; business/report views are lazy-loaded, and this is a performance warning rather than a failed build.

The STELLANTIS logo is reused from the user-approved Demo resource. Trademark rights remain with their owner; this application is not a statement of official authorization.

Full requirements and decision history: [development handover](../车辆数据管理正式版-需求与开发交接.md).
