# Stable Launcher Pre-Release

This implementation uses the existing signed Node.js runtime and an external browser. There is no native installer, .NET host, desktop shell, registry entry or system-policy change.

## Isolated manual trial

```powershell
.\scripts\try-stable.ps1
```

This branch is PRE-RELEASE ONLY. Do not merge it into main or publish a stable/latest release for acceptance. The source package version remains unchanged; packaging adds an explicit `-pre.N` version without editing package.json.

The helper chooses the oldest built pre package so a newer local preview can be installed from the browser. It saves program, data and local feed settings under `Documents\Work Files\01 Projects\VehicleManager Pre Preview`. Production data is not used. Register a disposable account, choose Set up later, then open Program updates and download/install the offered version.

For subsequent starts, double-click `program\Start.cmd` in that validation directory or run the helper again. The launcher remembers the same data directory and update feed without requiring temporary environment variables. The browser port can change.

## Developer release

```powershell
npm run package:stable -- --version 1.1.0-pre.1
npm run package:stable -- --version 1.1.0-pre.2
```

The command name refers to the stable LAUNCHER, not a stable RELEASE. Stable version numbers are rejected. Builds clean portable ZIPs and verifies them with the existing portable acceptance. `releases/pre` contains the ZIPs and `vehicle-manager-update-pre.json`. The manifest's Ed25519 signature covers the pre channel, application identity, Windows x64 platform, version, ZIP filename, byte count and SHA-256. Initial manual installation pins the public key. Publisher keys default to `Documents\Work Files\01 Projects\VehicleManager Pre Update Signing`; retain and protect the private key. `VEHICLE_MANAGER_SIGNING_DIRECTORY` overrides that location. The private key is never included in the ZIP or printed.

For GitHub acceptance, use tags such as `stable-launcher-v1.1.0-pre.1` and `stable-launcher-v1.1.0-pre.2`, targeting an explicitly approved commit on `feature/stable-launcher-updates`, not main. Upload the ZIP and pre-channel signed JSON to the same draft, mark it Pre-release, and publish only after both assets are present. Do not mark Latest. The updater lists releases rather than using `/releases/latest`, selecting only published prereleases with this tag prefix and `-pre.N` versions. Main releases, other feature previews and drafts are excluded. The selected tag version must match its signed manifest. Never reuse a version for different bytes. No GitHub publication happens automatically.

## Initial Preview Installation

Extract an approved pre-release ZIP and run `Install-Launcher.cmd` once. The fixed entry defaults to `%LOCALAPPDATA%\VehicleManager\pre-program\Start.cmd`, with separate `%LOCALAPPDATA%\VehicleManager\pre-data`. It does NOT migrate or open production data by default. Existing non-pre installations are rejected rather than overwritten. Register a disposable preview account; production accounts remain in their original directory. Do not point the preview at a production team for update acceptance.

The stable runtime and updater dependencies are copied outside version directories. Routine application ZIPs switch only the active application version; they do not silently replace the running launcher, rotate its signing key or upgrade its runtime. Those changes require a separately coordinated launcher deployment.

## Update transaction

1. Authenticate locally, check for updates, download a signed full ZIP and validate limits, hash, application identity and archive paths. HTTPS redirects are restricted to GitHub's known asset hosts. Local feed directories are explicit installation configuration, not arbitrary web input.
2. Save all tabs and finish pending changes/conflicts in all local workspaces. Existing API admission checks block concurrent requests; new synchronization ticks stop.
3. Persist an installation intent; wait for the managed launcher and service to exit cleanly. The stable supervisor keeps ownership of the transaction.
4. Make and hash-verify a full cold local-data backup. Reject filesystem links. A separate data update lock prevents another compatible launcher opening the data during backup/checks.
5. Start the staged version with business APIs and synchronization disabled. Verify the service identity and every local workspace database, then atomically switch the active pointer and activate the service.
6. If pre-activation checks fail and the service can be verified stopped, preserve failed data, restore the complete pre-update local backup, and restart the previous version. Never roll back shared data. After commit, do not auto-restore data and erase new work.

An incomplete transaction after power loss/unsafe shutdown blocks automatic continuation and requires manual recovery using `update-journal.json`, backups and `launcher.log`. Recovery does not guess whether shared writes happened. Backups and failed-data directories are sensitive, unencrypted, retained locally, and not automatically pruned. Preserve them; they are not independent disaster backups.

## Acceptance

```powershell
npx tsx --test test/stable-update.test.ts test/updates.test.ts
node scripts/smoke-stable.mjs releases/<older-extracted-pre-package> releases/pre
node scripts/smoke-stable.mjs releases/<older-extracted-pre-package> releases/pre --rollback
```

The smoke test installs into a new temporary directory and checks actual restart, account/device retention, original files, full backup integrity, saved source and data-path settings. Rollback mode intentionally modifies only its staged test version to fail health checks after altering a sentinel, and verifies restoration plus old-version restart. It never uses production data or changes endpoint policy.

The local ZIP path is validated independently of GitHub hosting. Actual GitHub publication/download acceptance remains necessary before team rollout. Update-manifest signing is not Windows code signing and does not guarantee endpoint approval; if company policy blocks Node/scripts, obtain IT approval rather than changing execution strategy to bypass it.