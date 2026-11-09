# AI intake execution progress

Plan: 2026-11-09-vehicle-intelligence-architecture.md

- User approved execution on the existing vehicle-manager feature branch.
- Ruling: preserve existing business services and implement a usable intake slice before broad behavior-equivalent module extraction. This reduces the combined migration surface; broader refactoring remains pending.
- Baseline: 517 passed, 2 optional skips, zero failures.
- Completed implementation: validated identifier contract, exact matching with mixed vehicle/component context, authenticated gateway, durable per-device attempted-call quota and token usage, PNG/JPEG validation, workspace-scoped recognition route, explicit editor field application, local barcode decoding and selected PDF page preparation.
- Red/green evidence: missing intake contract failed before implementation; mixed VIN/serial matching reproduced zero matches before repair; invalid image accepted by gateway before binary validation, rejected afterward. Focused tests passed after repairs.
- Independent review: mixed-context matching and alternate authorization-header quota identity findings corrected; follow-up found no further blocking issue within the single-instance experiment boundary.
- Browser acceptance: isolated fictional account/team verified PDF page rendering under production CSP, extracted PDF text, missing-gateway error, generated QR decoding and explicit mapping into the VIN input. Recognition was not submitted to a real provider. Cropped QR detection required a pure-code fallback; added a pixel-level generated QR regression and bounded one-shot decoding instead of image reader retries. ZXing pinned to the tested 0.21.3 release line.
- Final automated acceptance: 522 passed, 2 optional skips, zero failures (524 total). Production build, source version consistency and lint passed; four pre-existing training-script lint warnings remain. Final browser checks used generated files and an isolated temporary team. No official package or release was produced.
- Pending: real-material and real multi-device SMB acceptance, deployment against the actual team endpoint, provider account validation, persistent evidence/backup contract, durable tasks and monetary budget reservations, enrollment, complete multi-code and fuzzy candidate UI. No production data or user API key used.
