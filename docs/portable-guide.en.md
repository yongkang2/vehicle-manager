# Vehicle Manager: Portable User Guide

This guide covers application **1.9.0**. Use the release page and the installed application's version display to identify a published package. Real multi-computer Windows SMB acceptance remains specific to the destination environment; it has not been completed for this release.

## Installation

Download the latest official Windows x64 ZIP from:
https://github.com/yongkang2/vehicle-manager/releases/latest

Choose the application ZIP, rather than GitHub's source-code archives. Extract the entire ZIP to a writable local folder. Do not run the application inside the ZIP or from the team share. The package includes Node.js and production dependencies; no separate Node.js or npm installation is required.

## Start and stop

Double-click Create-Desktop-Shortcut.cmd to create a Vehicle Manager desktop shortcut with the application icon. Keep the extracted folder in place; recreate the shortcut after moving the folder or installing a new release.

Double-click Start.cmd to start the local service and open your browser. The service uses a free local port. Run Stop.cmd to stop safely and finish pending work before the database closes. Closing all application pages also permits automatic shutdown after the browser-presence checks and reconnect grace period. Hidden or minimized pages keep the service running.

## Accounts and local data

Create your own local account. Local data normally resides in %LOCALAPPDATA%\VehicleManager\data. An explicitly configured VEHICLE_MANAGER_DATA_DIR takes precedence. The application can migrate supported legacy data directories on startup after verifying the copied files.

Do not copy another person's local data or distribute a populated data directory. Keep your own device identity, accounts, sessions, pending changes and files together. Do not delete SQLite databases or WAL files to resolve synchronization problems.

Administrators can inspect the Device audit log. New entries display the local account name and username recorded at operation time; details retain the original actor ID, device ID and applicable team identity. Later profile changes do not rename these snapshots. Older entries are explicitly identified as current-profile lookups or unconfirmed historical identities, rather than reconstructed as operation-time evidence. Search accepts identity names and IDs. Local audit identity is not synchronized or included in business backups.

## Team collaboration

Configure the existing Windows SMB shared folder in the application. Only the team owner initializes a new team in an empty folder. Colleagues select the existing team and request approval. An administrator must approve membership and device access before collaboration is available.

The shared folder is not an installation directory. Windows permissions, network availability and company security policies still apply. Do not edit shared metadata, downgrade snapshots or delete lock files manually. Unsupported formats or a higher minimum client version require a compatible application release.

## Working with vehicles and reports

Use the vehicle list and detail views to manage vehicles, components, attachments and history. Enter a change reason where required. DOVE imports retain original workbook bytes; review the preview, vehicle association and optional controller updates before confirming. A report without a VIN requires an explicit association with an existing vehicle. Review conflicts before resolving them.

Pending offline changes remain local until synchronization succeeds. Pausing synchronization keeps pending changes queued; resume explicitly when ready. Team permissions and archived-record restrictions continue to apply.

Report archive shows active and archived reports together. Filter by vehicle model/VIN, or combine space-separated keywords across vehicle identity, project, report name and dates. Select one or more reports to download originals (a ZIP for multiple reports); administrators can archive selected active reports with a reason. Selection persists across pages and clears when filters change. Failed archive items remain selected for retry. Open a report to view its contents or restore an archived report.

To compare, select exactly two unarchived reports belonging to the same vehicle and associated VIN. The earlier acquisition is the left baseline; acquisition time and filename identify each side. Comparison uses the authorized local snapshot without waiting for shared synchronization. Differences appear first with details collapsed; turn off Differences only to inspect unchanged entries. Expand a row to see aligned values, and review ambiguous duplicate matches manually.

## Onboard equipment

In Add/Edit, **Installed on (optional)** and **Removed on (optional)** can both be blank or filled independently. Supplied dates must be valid; when both are present, removal cannot precede installation. Name, **Type** and Reason for change are required on every manual Add/Edit save, including older records. Type has no default: choose exactly `ETAS tools`, `Basic Equipment`, `Charging Adaptors`, `Hook`, `Controller` or `Others`. Both languages show the same choices. Existing blanks display as `—`; archive/restore and genuine removal-only actions remain compatible.

**Attachments (optional)** accepts up to eight `.xls`, `.xlsx`, `.pdf`, `.png`, `.jpg`, `.jpeg` or `.jfif` files per batch, 10 MB per file. Choose or remove files before clicking Save. The equipment saves first, then valid files upload sequentially without another confirmation. A file failure does not undo the equipment or successful uploads; retry failed files without saving the record again. Before sending each file, the browser reads a stable byte copy; an unreadable file must be removed and selected again. A connection failure pauses unsent files and leaves only the interrupted upload uncertain. Refresh and inspect the saved list before continuing; an uncertain file is never retried automatically. A definite rejected save remains editable, while session or receipt failures require closing and refreshing/signing in, then inspecting equipment before reopening. Type is retained in history, synchronization, JSON/CSV and backups; existing CSV templates keep their selections. Upgrade collaborating clients together to preserve the new field. Cancelling before Save changes nothing; closing after saving retains committed work.

Files belong to the equipment UUID, remain linked after a rename and appear in its expanded details and the vehicle Attachments list with their equipment association. Existing download/archive permissions apply. Archived equipment retains readable files but accepts no new uploads. Offline and paused-sync saves remain local and queued; they do not resume synchronization. Switching vehicles/workspaces or logging out cancels unsent files and discards stale responses.

## Vehicle Modification

The vehicle section is named **Vehicle Modification**. Each record has a name, description, **Start Date** and **Finish Date**, plus optional **Requestor** and **Lead** fields. These two fields belong to modifications; **Onboard equipment** remains a separate workflow. Before activation, Requestor and Lead inputs are disabled; you can still maintain basic names, descriptions and dates on records without enhanced values.

Before upgrading, stop all old services and independently back up the complete shared folder and each local data directory, including original files. After every collaborating client has upgraded to a compatible version, an online administrator with synchronization resumed can choose **Enable enhanced modifications** and enter a reason. This upgrades the shared business format to protocol **5** and unlocks **Requestor, Lead, files and Linked mode together**. Older clients cannot publish to it; enabling this feature does not automatically enable configuration revisions or component review policies.

Existing Requestor/Lead values and pending changes are retained before activation. Editing or copying a record with nonblank Requestor/Lead, restoring those values or publishing pending work containing them is blocked until activation. Basic records without enhanced values can still be edited or copied. Files and Linked mode remain unavailable until activation.

Save a modification before adding files in its expanded details. Each upload batch accepts at most **8 files**, up to **10 MB per file**, with exactly these extensions: `.doc`, `.docx`, `.txt`, `.xls`, `.xlsx`, `.pdf`, `.eml`, `.msg`, `.7z`, `.zip`. Review the queue and enter a reason before uploading. Files retain their original names and bytes; structural validation does not execute their contents. File archive/restore requires an administrator.

Use **Populate to vehicles** to search existing eligible vehicles by any part of a VIN and explicitly select up to **100 destination vehicles per action**. No vehicle is selected automatically. Choose **One-time copy** or **Linked**, review the destinations and file count, enter one reason, then use the final **Populate** action. A one-time copy gives each destination independent current fields, dates and active files; later edits do not propagate. Linked mode shares all fields, dates and files, including Requestor and Lead. Editing from any linked vehicle changes the common record for every linked vehicle, shown in the review.

Linked creation, editing, file changes, unlinking and archiving require connectivity and explicitly resumed team synchronization. Resume through **Personal workspace**; these actions do not resume it for you. Resolve pending changes/conflicts and refresh an outdated review before submitting. Independent edits and one-time copies that meet these activation rules retain the normal offline queue behavior.

**Unlink and keep independent copy** freezes only this vehicle's current fields, dates and files into an independent record. Archiving a linked modification, or its vehicle, freezes an independent archived copy for that vehicle; restoring it does not rejoin the group. Other vehicles remain linked. Permanently deleting one vehicle removes its membership and preserves the other vehicles' shared record and files. If a response is lost, retry the same action or refresh and inspect the saved result before starting another.

## Configuration revisions and component types

After all collaborating installations upgrade, an administrator can enable configuration revisions for the team. Maintain the vehicle's HV Battery, eMotor, Controllers, Thermal Management and any additional component records, then review and publish R01, R02 and later revisions. Required missing details need an explicit explanation. Publication requires an online session with synchronization resumed; component editing remains available offline.

Administrators can disable, remove or restore any configuration component type, including the four built-ins. This changes future revision reviews only: vehicle sections, installed components and published history remain available. Removed types can be found through Show removed and restored with their original identity. Catalog changes invalidate open reviews. Published revisions stay read-only; corrections create another revision.

Configuration activation requires at least shared business protocol 3; the first review-policy change raises it to at least 4. **Enable enhanced modifications** upgrades it to 5 and unlocks Requestor, Lead, files and Linked mode. Application 1.9.0 supports protocols **1–5** and local schema **6**; activation, synchronization and restore never downgrade an active protocol. Upgrade collaborating clients together. Current business backups use **format 5, field version 4**, preserving configuration history, modification groups/files and durable receipts. Formats **1–4** remain readable; older backups cannot reactivate removed types or rewrite published history. Historical policy-enabled format-4 backups use field version 3.


## Backups and upgrades

Before changing application versions, save your work, stop the old service, and independently back up the complete local data directory and shared folder to protected storage. An automatic migration backup is not a complete disaster-recovery backup and may omit separate blob files.

Install a new release in a writable local folder and retain your own data-directory configuration. Upgrade collaborating clients together before administrator activation. Current versions use manual downloads; automatic application updating is disabled. Older clients reject schema-6 databases and format-5 business backups. A new-format export cannot make an older application compatible. To roll back, stop the service, preserve newer work separately and have a maintainer restore the complete pre-upgrade backup with its compatible application; do not overwrite a live database or downgrade shared metadata.

Administrative business exports and backups are separate from complete local-data backups. Review restore previews, conflicts, dropped fields and confirmation prompts before applying a restore. Backups are not encrypted; store them in approved protected locations.

## Troubleshooting

If startup fails, read launcher.log next to Start.cmd and startup.log in the configured local data directory. A legacy update lock or an unverified running process can block startup to protect local data. Resolve the reported condition rather than deleting databases or shared files.

The failure window prints full log paths. The default service log is `%LOCALAPPDATA%\VehicleManager\data\startup.log`; an explicit `VEHICLE_MANAGER_DATA_DIR` changes this location. Repeated clicks wait briefly for the first Windows launcher instead of starting another service. If startup is still in progress, allow it to finish. Empty locks left by an interrupted startup recover automatically; do not delete data or lock files manually to bypass a reported protection.

Real multi-computer Windows SMB behavior and company endpoint policies require validation on the destination computers. Keep protected backups before investigating compatibility or recovery problems.

## Publication language

Commit messages, PR titles and descriptions, release titles and notes, asset names and packaged instructions use English. The application's English and Chinese interface options remain available.

## Verified business recovery

Administrators choose Back up data to synchronize team data and download a complete business backup. Synchronization failures or unresolved conflicts stop the download. The local-only backup remains available for maintenance through the API and never starts synchronization. Backups remain unencrypted.

Restore previews validate originals and display searchable effects and field differences. Confirm all archive effects together. Before applying, the service saves and read-back verifies a local safety ZIP under the workspace data directory's `restore-backups/`; failure prevents application. Copies are retained until manually removed and do not replace independent cold backups. Current business backups use format 5 with field version 4; formats 1–4 remain readable.

Restore history and results are local administrator records. Durable request IDs prevent reapplication after a lost response; the applied receipt and business changes commit in one transaction. Query results before retrying. Applied results can retry shared publication without applying the ZIP again. Prepared or failed requests require a fresh preview. Published means shared publication completed, not that all clients have refreshed. Permissions, permanent deletions and immutable configuration history are not rolled back. Continue pausing other clients and keeping independent backups for recovery operations.

Modification restores publish the reviewed group and memberships together. Compare-and-swap checks compare the reviewed base states and shared group version before publication; a newer shared change stops publication instead of overwriting it. The unpublished payload and referenced files remain available in **Restore history**. Use **Export retained payload** to preserve a review copy, then **Retain and review again** with a reason to retain the attempted payload and refresh canonical shared data. This requires an online administrator with synchronization resumed. Create a fresh backup preview before another restore; the retained ZIP is recovery evidence, not an automatic replay action. Older backups cannot silently replace or detach an existing managed modification group.

Backup reminder: the overview menu contains Back up data, Restore data and Restore history. Online administrators are reminded when the team has no recorded backup or the last completed team-backup transfer was at least seven days ago. Completion time is shared by the team. Remind me tomorrow suppresses the prompt for the administrator on this device for the current local calendar day; work remains available. Local exports and automatic pre-restore safety copies do not reset the timer. Completed HTTP transfer does not verify where the browser saved the file. Old versions do not record completion, so collaborating administrators should use the updated application for reliable reminders.

## Troubleshooting evidence

When an operation fails, note its time/timezone, action, application version and error. Local diagnostics are stored in the data directory under `logs/diagnostics.jsonl` with up to three numbered archives (2 MiB each). The default directory is `%LOCALAPPDATA%\VehicleManager\data`; `VEHICLE_MANAGER_DATA_DIR` overrides it. In browser developer tools, the failed request's `X-Request-Id` response header identifies matching diagnostic entries. An offline browser request that never reaches the service has no server ID.

For startup failures, also preserve `startup.log` in the data directory and `launcher.log` beside the launcher. Review legacy logs for sensitive paths before sharing. Share only needed evidence through approved channels; do not send passwords, cookies, tokens, request bodies or a copy of your database. New structured diagnostics omit those values and business content. Log storage failures do not prevent normal operations, but evidence can be missing. No diagnostics are uploaded automatically.

Before retrying a write after an uncertain response, refresh and inspect its result. Do not delete the database, originals, shared snapshots or locks to fix a logging problem.

Startup text logs now prefix each new stdout/stderr line and each launcher error/stack line with an ISO 8601 UTC timestamp (`Z`) and its source. The service preloads timestamp handling before the main module, keeps it after a detached launcher exits, and still exits with failure on uncaught exceptions. Existing historical log lines are preserved unchanged; timestamps cannot be reconstructed retrospectively.
