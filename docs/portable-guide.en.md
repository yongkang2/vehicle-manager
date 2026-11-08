# Vehicle Manager: Portable User Guide

Development scope: the checked-out application is **1.6.0, unreleased**. The Vehicle Modification workflow below describes this development source, not an available official release or completed real-SMB acceptance. Use the release page and the installed application's version display to identify a published package.

## Installation

Download the latest official Windows x64 ZIP from:
https://github.com/yongkang2/vehicle-manager/releases/latest

Choose the application ZIP, rather than GitHub's source-code archives. Extract the entire ZIP to a writable local folder. Do not run the application inside the ZIP or from the team share. The package includes Node.js and production dependencies; no separate Node.js or npm installation is required.

## Start and stop

Double-click Start.cmd to start the local service and open your browser. The service uses a free local port. Run Stop.cmd to stop safely and finish pending work before the database closes. Closing all application pages also permits automatic shutdown after the browser-presence checks and reconnect grace period. Hidden or minimized pages keep the service running.

## Accounts and local data

Create your own local account. Local data normally resides in %LOCALAPPDATA%\VehicleManager\data. An explicitly configured VEHICLE_MANAGER_DATA_DIR takes precedence. The application can migrate supported legacy data directories on startup after verifying the copied files.

Do not copy another person's local data or distribute a populated data directory. Keep your own device identity, accounts, sessions, pending changes and files together. Do not delete SQLite databases or WAL files to resolve synchronization problems.

## Team collaboration

Configure the existing Windows SMB shared folder in the application. Only the team owner initializes a new team in an empty folder. Colleagues select the existing team and request approval. An administrator must approve membership and device access before collaboration is available.

The shared folder is not an installation directory. Windows permissions, network availability and company security policies still apply. Do not edit shared metadata, downgrade snapshots or delete lock files manually. Unsupported formats or a higher minimum client version require a compatible application release.

## Working with vehicles and reports

Use the vehicle list and detail views to manage vehicles, components, attachments and history. Enter a change reason where required. DOVE imports retain original workbook bytes; review the preview, vehicle association and optional controller updates before confirming. A report without a VIN requires an explicit association with an existing vehicle. Review conflicts before resolving them.

Pending offline changes remain local until synchronization succeeds. Pausing synchronization keeps pending changes queued; resume explicitly when ready. Team permissions and archived-record restrictions continue to apply.

## Vehicle Modification

The vehicle section is named **Vehicle Modification**. Each record has a name, description, installation/removal dates and optional **Requestor** and **Lead** fields. These two fields belong to modifications; **Onboard equipment** remains a separate workflow. Existing text records remain usable before file and sharing activation.

After every collaborating client has upgraded to a compatible version, an online administrator with synchronization resumed can choose **Enable modification files and sharing** and enter a reason. This upgrades the shared business format to protocol **5**. Older clients cannot publish to it; enabling this feature does not automatically enable configuration revisions or component review policies.

Save a modification before adding files in its expanded details. Each upload batch accepts at most **8 files**, up to **10 MB per file**, with exactly these extensions: `.doc`, `.docx`, `.txt`, `.xls`, `.xlsx`, `.pdf`, `.eml`, `.msg`, `.7z`, `.zip`. Review the queue and enter a reason before uploading. Files retain their original names and bytes; structural validation does not execute their contents. File archive/restore requires an administrator.

Use **Populate to vehicles** to search existing eligible vehicles by any part of a VIN and explicitly select up to **100 destination vehicles per action**. No vehicle is selected automatically. Choose **One-time copy** or **Linked**, review the destinations and file count, enter one reason, then use the final **Populate** action. A one-time copy gives each destination independent current fields, dates and active files; later edits do not propagate. Linked mode shares all fields, dates and files, including Requestor and Lead. Editing from any linked vehicle changes the common record for every linked vehicle, shown in the review.

Linked creation, editing, file changes, unlinking and archiving require connectivity and explicitly resumed team synchronization. Resume through **Personal workspace**; these actions do not resume it for you. Resolve pending changes/conflicts and refresh an outdated review before submitting. Independent edits and one-time copies retain the normal offline queue behavior.

**Unlink and keep independent copy** freezes only this vehicle's current fields, dates and files into an independent record. Archiving a linked modification, or its vehicle, freezes an independent archived copy for that vehicle; restoring it does not rejoin the group. Other vehicles remain linked. Permanently deleting one vehicle removes its membership and preserves the other vehicles' shared record and files. If a response is lost, retry the same action or refresh and inspect the saved result before starting another.

## Configuration revisions and component types

After all collaborating installations upgrade, an administrator can enable configuration revisions for the team. Maintain the vehicle's HV Battery, eMotor, Controllers, Thermal Management and any additional component records, then review and publish R01, R02 and later revisions. Required missing details need an explicit explanation. Publication requires an online session with synchronization resumed; component editing remains available offline.

Administrators can disable, remove or restore any configuration component type, including the four built-ins. This changes future revision reviews only: vehicle sections, installed components and published history remain available. Removed types can be found through Show removed and restored with their original identity. Catalog changes invalidate open reviews. Published revisions stay read-only; corrections create another revision.

Configuration activation requires at least shared business protocol 3; the first review-policy change raises it to at least 4. Modification file and sharing activation upgrades it to 5. Development application 1.6.0 supports protocols **1–5** and local schema **6**; activation, synchronization and restore never downgrade an active protocol. Upgrade collaborating clients together. Current business backups use **format 5, field version 4**, preserving configuration history, modification groups/files and durable receipts. Formats **1–4** remain readable; older backups cannot reactivate removed types or rewrite published history. Historical policy-enabled format-4 backups use field version 3.

## Backups and upgrades

Before changing application versions, save your work, stop the old service, and independently back up the complete local data directory and shared folder to protected storage. An automatic migration backup is not a complete disaster-recovery backup and may omit separate blob files.

Install a new release in a writable local folder and retain your own data-directory configuration. Upgrade collaborating clients together. Current versions use manual downloads; automatic application updating is disabled. Database upgrades can prevent older clients from opening local data, so rollback may require restoring a complete pre-upgrade backup after stopping the service and preserving newer work.

Administrative business exports and backups are separate from complete local-data backups. Review restore previews, conflicts, dropped fields and confirmation prompts before applying a restore. Backups are not encrypted; store them in approved protected locations.

## Troubleshooting

If startup fails, read launcher.log next to Start.cmd and startup.log in the configured local data directory. A legacy update lock or an unverified running process can block startup to protect local data. Resolve the reported condition rather than deleting databases or shared files.

Real multi-computer Windows SMB behavior and company endpoint policies require validation on the destination computers. Keep protected backups before investigating compatibility or recovery problems.

## Publication language

Commit messages, PR titles and descriptions, release titles and notes, asset names and packaged instructions use English. The application's English and Chinese interface options remain available.

## Verified business recovery

Administrators choose Back up data to synchronize team data and download a complete business backup. Synchronization failures or unresolved conflicts stop the download. The local-only backup remains available for maintenance through the API and never starts synchronization. Backups remain unencrypted.

Restore previews validate originals and display searchable effects and field differences. Confirm all archive effects together. Before applying, the service saves and read-back verifies a local safety ZIP under the workspace data directory's `restore-backups/`; failure prevents application. Copies are retained until manually removed and do not replace independent cold backups. Current development backups use format 5 with field version 4; formats 1–4 remain readable.

Restore history and results are local administrator records. Durable request IDs prevent reapplication after a lost response; the applied receipt and business changes commit in one transaction. Query results before retrying. Applied results can retry shared publication without applying the ZIP again. Prepared or failed requests require a fresh preview. Published means shared publication completed, not that all clients have refreshed. Permissions, permanent deletions and immutable configuration history are not rolled back. Continue pausing other clients and keeping independent backups for recovery operations.

Modification restores publish the reviewed group and memberships together. Compare-and-swap checks compare the reviewed base states and shared group version before publication; a newer shared change stops publication instead of overwriting it. The unpublished payload and referenced files remain available in **Restore history**. Use **Export retained payload** to preserve a review copy, then **Retain and review again** with a reason to retain the attempted payload and refresh canonical shared data. This requires an online administrator with synchronization resumed. Create a fresh backup preview before another restore; the retained ZIP is recovery evidence, not an automatic replay action. Older backups cannot silently replace or detach an existing managed modification group.

Backup reminder: the overview menu contains Back up data, Restore data and Restore history. Online administrators are reminded when the team has no recorded backup or the last completed team-backup transfer was at least seven days ago. Completion time is shared by the team. Remind me tomorrow suppresses the prompt for the administrator on this device for the current local calendar day; work remains available. Local exports and automatic pre-restore safety copies do not reset the timer. Completed HTTP transfer does not verify where the browser saved the file. Old versions do not record completion, so collaborating administrators should use the updated application for reliable reminders.
