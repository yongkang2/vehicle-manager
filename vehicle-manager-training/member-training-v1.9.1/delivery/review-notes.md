# Delivery review notes

## Version and duration

This training video demonstrates official Vehicle Manager **v1.9.1**, pinned to
source commit `6f9354ac76e7999e9a115ad6aa95417366f01a0a`. Its final duration is
**4:49.533** (289.533 seconds; 8,686 frames at 30 fps).

The recording used a separate application checkout and disposable fictional
workspace. The original working checkout remained at v1.9.0 with its existing
local changes preserved. This media delivery is not a new application release.

The chapter boundaries differ from the initial approximately 4½-minute storyboard.
They follow the complete normal-speed Xiaoyi narration and readable scene holds;
speech was neither time-stretched nor cut to force the original timings. The
actual sequence and chapter times are in `script-and-chapters.md` and `timeline.json`.

## Automated checks

- The complete MP4 decoded successfully. Verified streams are 1920 × 1080,
  30 fps, H.264/yuv420p picture and stereo 48 kHz AAC audio.
- All 40 Chinese subtitle cues match the script and scene timing, use at most
  two lines, and keep the complete spoken segment inside its scene.
- All 40 source speech segments were preserved exactly before mixing. The
  minimum correlation between reference speech and the decoded final mix is
  **0.96398**. This is a signal-preservation check, not a pronunciation score.
- Final decoded audio contains **zero clipped samples**. Background music is
  looped with crossfades, lowered under speech and faded at both ends.
  A residual-audio continuity check passed for all **286 one-second windows**
  between the intentional fades; its quietest window measured -57.96 dBFS,
  above the -65 dBFS silence threshold. This remains an automated signal check.
- Automated speech recognition checked all **40 segments**, with **no review
  flags** under the verifier's character-error criterion.
- Eight recorded access checks identify an approved ordinary member during
  business operations. Administrative setup and approval stayed off-camera.
- The actual downloaded equipment CSV contains **one equipment data row**. Its
  explicitly selected Vehicle VIN value matches the fictional parent vehicle,
  `TEST0000000000002`.

All **60 pre-existing files** in the preservation snapshot retained their
original SHA-256 values. The isolated application checkout remains clean, and
the dedicated demonstration service and recording browser were stopped.

The machine-readable verification and provenance files contain the detailed
measurements and final movie hash. `SHA256SUMS.txt` provides the delivery checksums.

## What the picture shows

The software footage is freshly captured from the pinned application's Chinese
interface. Chapter headings, captions, cursor emphasis and the following evidence
panels are production overlays rather than additional application screens:

- The equipment CSV excerpt is a clearly labeled, read-only presentation of the
  actual file downloaded during recording. Its rows are not invented examples.
- The closing shutdown result is a labeled presentation of the actual isolated
  `Stop.cmd` execution and graceful-stop evidence over the existing interface.
  It does not introduce a new application shutdown button or page.

`Start.cmd` is explained in narration; launching it from the Windows desktop was
not filmed. Onboarding shows registration, joining and the approved state, while
the administrator's approval action occurs off-camera. Paused-sync recovery is
explained conditionally through Personal workspace; the recording does not force
the team into a paused state or manufacture a conflict.

## Visual review and listening limits

An assistant visually sampled **all 80 extracted frames across eight chapter
contact sheets** to inspect interface scope, caption placement, readable controls
and the displayed workflow evidence. This is sampled assistant visual review,
not continuous human viewing.

No continuous human listening or human visual review is claimed. Those flags
remain false in the reports. Full decoding, signal comparison and speech
recognition do not establish subjective naturalness or replace listening to the
entire finished video.
