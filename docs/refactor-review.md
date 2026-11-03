# Conservative simplification review

Approved scope: remove automatic updates; preserve all other observable workflows and database/schema/shared protocol/backup compatibility. Branch: refactor/remove-auto-updates-and-simplify. Base: fda0972 (version 1.1.3).

## Baseline
Full suite: 380 passed, 2 skipped, 0 failed. Existing user working changes and previous UI review artifacts are excluded from this work. Tests and portable acceptance use independent temporary data, not live business databases.

## Decisions and execution
- Remove the disconnected automatic-update backend, launcher commands, packaged installation script, dedicated types, retired tests and unused translations. Preserve version display and manual release links.
- Keep the legacy update-lock refusal: another old installation may still be performing an update. Do not allow simultaneous access to its database. No updater-specific environment-variable bypass remains.
- Remove the unused direct semver dependency; retain unzipper because backup and DOVE parsing use it.
- Remove update-only ordinary-request accounting and maintenance phase state. Existing workspace-specific in-flight protection and shutdown settling remain.
- Consolidate equivalent visual overrides with identical effective values and preserve mobile specificity. No layout redesign.
- Preserve src/api.ts's distinct token/scope validation paths: superficially similar handlers protect different authenticated operations.
- Do not merge backup preview/restore validation: they differ intentionally and touch restoration safety. Do not split BusinessApp solely to reduce file length. This review found no demonstrated runtime benefit worth changing these business boundaries.
- No database migrations, field changes, backup-format changes, shared-protocol changes, new dependencies or features. Version is bumped to 1.1.4 for delivery.

## Verification
The new behavioral test first failed against the existing updater endpoint (200 instead of 404), then passed after removal. It verifies retired endpoints, normal registration/bootstrap, schema identity and schema version within an isolated test database. Run full tests, build/typecheck, lint, portable packaging/acceptance, and browser locale/login checks before final delivery. Record final results after execution.

## Completed validation
- Full post-change suite for version 1.1.4: 371 passed, 2 skipped, 0 failed. Retired updater tests account for the reduction from the baseline; removal endpoint regression added.
- Additional launcher regression: retired command rejection and fail-closed legacy lock protection passed; no local database is created by either rejection path. Both tests in no-auto-updates.test.ts pass.
- Production build and TypeScript checks passed. Lint passed with four existing training-file warnings; the launcher unused-variable warning is removed.
- Browser authentication checks passed in both locales and both authentication modes at 1440, 390 and 320 pixels, zero locale-induced input-position shift, no browser exceptions.
- Independent scoped review found no material issues.
- Protected database/domain/sync/backup/team/workspace/deletion sources have no differences from HEAD. Implementation tests used isolated data. The existing local service was restarted normally for delivery and reports version 1.1.4.
- Portable ZIP build and extracted acceptance passed: bundled runtime, bootstrap/login page/JavaScript HTTP 200, graceful stop. ZIP contains no retired updater. Artifact: releases/vehicle-manager-1.1.4-win-x64-20261103095332.zip.

## Formal release gate
The previously stale business smoke script is repaired (missing createRequire import and current required vehicle classification). All workbook parsing libraries are loaded from the packaged application, not development dependencies. The harness and child services use the bundled runtime; child PATH contains only that runtime, NODE_PATH is removed and NODE_OPTIONS is cleared. Its data and shared folders are fresh temporary paths containing Unicode and spaces.

Final ZIP acceptance now mandates this workflow check after extracting the archive: first registration, team creation, vehicle creation, isolated DOVE parsing, exact original-byte download, backup manifest records, safe stop/restart and login with persistent vehicle/report records. Failure prevents successful packaging. This supplements, rather than replaces, the full 371-passing / 2-skipped suite. No application/database behavior is changed by these verification-script fixes. Independent review found no material issues; actual colleague endpoint policies and real SMB behavior remain outside local-machine validation.
