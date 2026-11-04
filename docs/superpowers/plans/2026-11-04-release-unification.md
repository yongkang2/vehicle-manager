# Release Unification Implementation Plan

Goal: align the local checkout, GitHub main and a new immutable v1.2.2 release.
Spec: docs/release-consistency-proposal.md. Execute inline with executing-plans.

- [x] Preserve existing changes in a named stash; fast-forward main to origin/main; archive the conflicting local v1.0.2 tag before correcting it.
- [ ] Add failing tests for version consistency and independent package-version overrides; implement a small checker using existing Node tools.
- [ ] Remove independent package/runtime version overrides. Integrate source/built version checks and remote release preflight into packaging. Generate package provenance and checksum.
- [ ] Bump to 1.2.2, update long-term rules and release documentation. Run tests, lint, build and packaged acceptance.
- [ ] Commit only this task, open and merge a PR after checks; package the exact merged source and publish one release. Verify downloaded checksum.
- [ ] Align local main, archive historical local artifacts without deletion, clarify historical GitHub release metadata, and document retained branches/worktrees.

Constraints: retain all business data, existing user changes, historical tags and assets; no force-push or database changes. Failed checks stop publication. Old worktrees remain untouched.
