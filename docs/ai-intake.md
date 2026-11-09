# AI-assisted intake experiment

This branch adds optional recognition to existing vehicle and part editors. Existing manual saves and business validation remain authoritative. This is an experimental source build, not an official release.

## Client workflow

1. Open Add/Edit for a vehicle, controller or battery.
2. Choose a JPEG/PNG or PDF up to 5 MiB. PDFs are limited to 100 pages; select one page at a time. The preview shows what will be sent.
3. A local decoder attempts one barcode/QR result. Choose the destination field explicitly. Multiple-code enumeration and supplier-specific payload parsing are not implemented; never assume the first decoded value identifies the intended component.
4. Optionally choose **Extract fields with AI (send current image)**. This transmits the selected image/page to the configured service and its AI provider.
5. Check the preview, choose fields and fill them. Applying replaces selected form values, including unsaved manual values. Required classifications remain manual. Save with a change reason using the existing editor.

Exact matches are counted in the current authorized workspace. Shared part numbers and repeated serial numbers never automatically associate or move components. PDF text is displayed locally for reference; this iteration sends a rendered selected page for AI recognition. DOVE XLSX continues through its existing importer.

## Gateway deployment

Use a dedicated server checkout with Node.js 24 and dependencies installed. Run `npm run build` first. Configure environment variables in the service manager; never commit keys or place them in a portable package:

| Server variable | Meaning |
|---|---|
| `DEEPSEEK_API_KEY` | Provider key, held only by the gateway |
| `VEHICLE_AI_DEVICE_TOKENS` | Comma-separated independent random device tokens, each at least 32 characters |
| `VEHICLE_AI_DATA_DIR` | Dedicated absolute local directory for `usage.sqlite` |
| `VEHICLE_AI_DAILY_LIMIT` | Per-device UTC-day attempted call limit; default 100 |
| `VEHICLE_AI_PORT` | Loopback listening port; default 4420 |

Start with `node dist-server/server/ai-gateway-main.js`. Put an HTTPS reverse proxy in front of this loopback service for remote clients. The reverse proxy must allow uploads of approximately 8 MiB and requests lasting 60 seconds. Do not expose the Vehicle Manager business server as the gateway.

Configure each client's launcher/service environment with `VEHICLE_AI_GATEWAY_URL` (HTTPS origin) and `VEHICLE_AI_DEVICE_TOKEN` (that device's token). Loopback HTTP is allowed for isolated tests only. No provider key is needed on clients. Restart services after configuration changes. Remove a token from gateway configuration and restart to revoke it for new calls; admitted requests may still finish. This initial administrative process is manual, without an enrollment UI or SSO integration.

The gateway permits two concurrent provider calls and 20 requests/minute per credential. Attempted provider calls reserve a durable daily slot before transmission. Completed calls record supplied token usage; ambiguous failures remain `uncertain` and still consume a slot, including after restart. There are no automatic paid retries. The daily limit is a call-count bound, not a monetary budget or a promise about provider billing. A separate provider account/key and a small funded balance are recommended for the experiment.

## Current acceptance boundary

- Automated tests use fictional data and a simulated provider. No real key is used by the test suite.
- Recognition does not save business records; the existing editor confirms and saves them.
- Recognition drafts and preview files are transient. This iteration does not persist source-image provenance, distribute drafts across devices, or add source evidence to backup formats.
- Persistent recognition jobs, uncertain-request recovery UI, monetary monthly reservations, device enrollment, complete multi-code handling and fuzzy candidate selection remain later plan phases.
- Production-build browser checks verified a synthetic PDF page/text, a generated QR and explicit VIN field application. Accuracy on real labels/PDFs and multi-device acceptance remain outstanding; unsupported/unclear materials can always be entered manually.
- This is not a finished implementation of every phase in the architecture proposal. Do not publish it as a production-ready replacement without the remaining acceptance work.
