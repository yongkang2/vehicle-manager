# Local AI service deployment

User selected a local-computer trial. Development uses an isolated worktree on ai-assisted-intake; the original vehicle-ui-tweaks checkout and its uncommitted UI edits are untouched.

- Added user-bound encrypted provider-key configuration, local device/client setup, background gateway start, verified-process stop and isolated trial launch.
- Added authenticated provider status/model checks and sanitized actionable client errors.
- Added automatic local client configuration with URL/credential validation, BOM handling and environment overrides.
- Extended future portable packaging with explicit public script allowlists only; no local config or secrets are packaged.
- Actual official-provider check: HTTP 401 for the supplied key. The local gateway starts and reports AI_PROVIDER_AUTH. No successful recognition, real-material accuracy or team deployment is claimed.
- Targeted red/green: missing config loader, missing provider status endpoint and Windows UTF-8 BOM loading each failed before the corresponding implementation/fix; focused tests then passed.
- Windows configuration test verified encrypted fixture storage, credential-only client config and idempotent configuration. User key never appears in source or test fixtures.
- Validation: full suite 525 passed, 2 optional skips, zero failures. Build, version consistency and lint passed (four existing training-script warnings). After review, a new trial-stop regression failed for the missing wrapper, then passed after adding it; both Windows script tests passed. Start/stop/restart and authenticated status were exercised on the actual local gateway; it reports AI_PROVIDER_AUTH.
- Independent review: added the matching Stop-AI-Trial.cmd so trial stop never silently selects the normal data directory. No blocking secret-disclosure issue found.
- Real recognition awaits a valid provider key; team hosting is outside the user's selected local-trial scope. No official release or delivery ZIP was generated.
