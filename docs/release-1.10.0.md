# Vehicle Manager 1.10.0 candidate

This is an acceptance candidate from the pull request branch, not an official release. Latest remains 1.9.1 until a separate release operation. Official delivery must use clean merged main, the normal packaging checks and a unique final ZIP.

## Changes

- Avoid the team publication lock for verified unchanged background checks, retaining live access and rollback/protocol checks.
- Stagger background polling and share busy backoff across automatic refresh paths; manual synchronization remains available.
- Deduplicate successful blob transfers within one cycle, reuse local prepared statements and parsed views, and retain safe stage/lock diagnostics.
- Deliver paged vehicle summaries with whole-fleet counts/facets; load full vehicle/report context on demand. Preserve off-page modification scope and independent full CSV selection/export.
- Send long filter values in a bounded POST body instead of the HTTP request line.

## Compatibility and upgrade

No local schema, shared business protocol, backup format or minimum-client gate change. Existing 1.9.1 data directories and team shares remain the upgrade inputs. Stop all old services and independently preserve the full share and each local data directory before rollout. Use the existing data-directory configuration; do not initialize a replacement team. Review retained work and resume synchronization explicitly if prompted.

Published 1.9.1 ZIP SHA-256: `4570e4b51080f0027cd7c175913b72ecec7952c4d931680ebf6dfdd00f0d62f9`.

## Verification

- Source build, lint, version checks and full suite: 626 total, 624 passed, 2 skipped; existing lint/bundle warnings remain.
- Independent code review: long-filter request-line issue fixed with loader and HTTP regressions; no remaining actionable finding.
- `npm run package:portable`: clean-source remote checks, production dependency installation, extracted ZIP/runtime acceptance and workflow smoke checks.
- `node scripts/verify-portable-upgrade.mjs <official-1.9.1.zip> <candidate.zip>`: actual old-package creation of synthetic data/pending work, new-package opening of the same data, preserved originals/archives/configuration/linked scope, editing, two-client synchronization, old-backup restoration and restart persistence. Use its emitted JSON and the candidate provenance file for final acceptance results and artifact hashes.

Real business-data-copy and physical multi-computer SMB acceptance remain outside the local synthetic validation scope. A rollback after new writes must preserve/reconcile those writes rather than blindly restore an older backup.

## Candidate acceptance result

Candidate: `vehicle-manager-1.10.0-win-x64-20261113082156.zip`, built from clean commit `f23234c06fbb7908fc1cf1989600670bb8851714`.

SHA-256: `969005116f1296e1a8c591a6fe5bfad12043d09944fe94269025cb735d366f28`.

The complete packaging workflow and extracted-runtime smoke checks passed. Actual official 1.9.1 ZIP to candidate ZIP acceptance passed: existing account/team reuse, retained pending work, archived data, original bytes, immutable configuration, linked scope, paged details, editing, two-client synchronization, old-backup restoration and restart persistence. Both services used isolated synthetic data on one Windows host.

The upgrade harness was subsequently corrected to suppress PowerShell progress-buffer overflow, settle both asynchronous extractions before cleanup, and drain the old backup's post-response lease before simulating an unavailable share. These harness/document-only changes do not alter candidate application bytes; the candidate provenance remains the build commit above. Its accompanying upgrade acceptance JSON records the validation harness commit separately. No official release or tag was created.
