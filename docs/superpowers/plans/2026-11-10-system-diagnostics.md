# Local system diagnostics implementation plan

**Goal:** Make startup, authentication, API, synchronization and parser failures diagnosable without exposing business data or credentials.
**Approved approach:** Local structured JSONL diagnostics with request IDs, bounded rotation, safe metadata and failure isolation. User selected this approach and requested direct implementation.
**Alternatives:** Expanding startup.log leaves request/background correlation incomplete; an external platform adds deployment and data transfer. Use existing Node APIs, no dependencies.

- [x] Test redaction, rotation and unavailable log storage before implementation.
- [x] Add shared local diagnostic writer; keep records under 8 KiB and retain current plus three 2 MiB archives. Use synchronous bounded writes for low-frequency failures/lifecycle events to avoid shutdown and cleanup races; do not log routine polling successes.
- [x] Instrument request errors/slow requests with server-generated IDs and safe route templates, auth outcomes, lifecycle and background sync/parser failures. Preserve response error codes and business behavior.
- [x] Return request IDs in response headers and retain them in ApiError. Document how to collect logs and find failures; no unauthenticated diagnostic download API.
- [x] Test failure outcomes and privacy, run full tests/lint/build/version check and independent review.

Constraints: Never log raw bodies, headers, cookies, usernames, VINs, filenames, query strings, network paths, passwords, tokens or raw error messages/stacks. Keep safe error codes and stack frame basenames/line numbers. Logging errors must never alter business results. Logs are local troubleshooting artifacts, not durable business audit or backups. No schema/protocol/backup format changes. Launcher fallback remains available for failures before the service can initialize.

Validation (2026-11-10): final full suite 523 passed, 2 skipped, 0 failed (525 total). Build, lint and version consistency passed. Existing training-script lint and Vite chunk-size warnings remain. Independent review findings were fixed and re-reviewed: URL case/trailing-slash diagnostic coverage, isolated status-check insertion, and populated workspace-list behavior. Fault tests cover real invalid DOVE parsing with request context, log privacy, failed/successful auth, malformed JSON, offline status HTTP-200 failure/recovery transitions, rotation, unwritable storage and unavailable stderr. Real customer SMB outages and disk-full hardware acceptance were not performed.

Ruling: retain existing error toasts and public error payloads. Request IDs are available in response headers and ApiError for support collection; no new diagnostics UI, unauthenticated download endpoint or external collector. Preserve legacy startup/launcher logs for failures before service initialization. New structured diagnostics do not retroactively sanitize legacy files.
