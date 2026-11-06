# Vehicle Manager: Portable User Guide

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

## Team collaboration

Configure the existing Windows SMB shared folder in the application. Only the team owner initializes a new team in an empty folder. Colleagues select the existing team and request approval. An administrator must approve membership and device access before collaboration is available.

The shared folder is not an installation directory. Windows permissions, network availability and company security policies still apply. Do not edit shared metadata, downgrade snapshots or delete lock files manually. Unsupported formats or a higher minimum client version require a compatible application release.

## Working with vehicles and reports

Use the vehicle list and detail views to manage vehicles, components, attachments and history. Enter a change reason where required. DOVE imports retain original workbook bytes; review the preview, vehicle association and optional controller updates before confirming. A report without a VIN requires an explicit association with an existing vehicle. Review conflicts before resolving them.

Pending offline changes remain local until synchronization succeeds. Pausing synchronization keeps pending changes queued; resume explicitly when ready. Team permissions and archived-record restrictions continue to apply.

Report archive shows active and archived reports together. Filter by vehicle model/VIN, or combine space-separated keywords across vehicle identity, project, report name and dates. Select one or more reports to download originals (a ZIP for multiple reports); administrators can archive selected active reports with a reason. Selection persists across pages and clears when filters change. Failed archive items remain selected for retry. Open a report to view its contents or restore an archived report.

To compare, select exactly two unarchived reports belonging to the same vehicle and associated VIN. The earlier acquisition is the left baseline; acquisition time and filename identify each side. Comparison uses the authorized local snapshot without waiting for shared synchronization. Differences appear first with details collapsed; turn off Differences only to inspect unchanged entries. Expand a row to see aligned values, and review ambiguous duplicate matches manually.

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

Restore previews validate originals and display searchable effects and field differences. Confirm all archive effects together. Before applying, the service saves and read-back verifies a local safety ZIP under the workspace data directory's `restore-backups/`; failure prevents application. Copies are retained until manually removed and do not replace independent cold backups. Current backups use format 3 or 4 depending on configuration history; formats 1–4 remain readable.

Restore history and results are local administrator records. Durable request IDs prevent reapplication after a lost response; the applied receipt and business changes commit in one transaction. Query results before retrying. Applied results can retry shared publication without applying the ZIP again. Prepared or failed requests require a fresh preview. Published means shared publication completed, not that all clients have refreshed. Permissions, permanent deletions and immutable configuration history are not rolled back. Continue pausing other clients and keeping independent backups for recovery operations.

Backup reminder: the overview menu contains Back up data, Restore data and Restore history. Online administrators are reminded when the team has no recorded backup or the last completed team-backup transfer was at least seven days ago. Completion time is shared by the team. Remind me tomorrow suppresses the prompt for the administrator on this device for the current local calendar day; work remains available. Local exports and automatic pre-restore safety copies do not reset the timer. Completed HTTP transfer does not verify where the browser saved the file. Old versions do not record completion, so collaborating administrators should use the updated application for reliable reminders.
