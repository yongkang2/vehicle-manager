# Vehicle Manager v1.9.1: Chinese member training

**Final duration: 4:49.533** (289.533 seconds), within the requested 3–5 minutes.

This walkthrough uses freshly recorded Chinese interface footage from official
release **v1.9.1**, source commit
`6f9354ac76e7999e9a115ad6aa95417366f01a0a`.
It follows an ordinary member through onboarding, vehicle records, equipment,
attachment preview, DOVE reports, CSV export, history and synchronization.

## Watch and download

- [Training video](delivery/vehicle-manager-member-training-v1.9.1-zh-CN.mp4)
- [Matching Chinese subtitles](delivery/vehicle-manager-member-training-v1.9.1-zh-CN.srt)
- [Narration and actual chapter times](delivery/script-and-chapters.md)
- [Preview](delivery/preview.jpg)
- [Technical verification](delivery/verification.json)
- [Review notes and recording boundaries](delivery/review-notes.md)
- [Production provenance](delivery/production-provenance.json)
- [Delivery checksums](delivery/SHA256SUMS.txt)

The MP4 includes permanently embedded Simplified Chinese captions, normal-speed
Microsoft Xiaoyi Mandarin female narration and the **Close Up** instrumental
track by **Michael Ramir C.** Music is lowered beneath speech, looped with
crossfades and faded at the opening and closing. See [music credits](MUSIC-CREDITS.md).

The delivery is 1920 × 1080, 30 fps, with H.264/yuv420p video and stereo 48 kHz
AAC audio. The timeline and chapter notes use the actual final timing; scene holds
were adjusted to preserve every sentence at normal speed.

## Recording scope

All accounts, vehicles, workbooks, equipment and shared-folder data are fictional.
Recording uses a separate application checkout, disposable databases and a
dedicated browser profile. Team creation and feature activation are preparation
steps performed off-camera. The recording shows a newcomer applying to join;
approval occurs off-camera during onboarding. Business operations then use that
approved ordinary member. Administrative screens and actions are excluded.

Equipment CSV export explicitly retains the existing **Vehicle VIN** column.
The recording demonstrates the released behavior; it does not depend on a new
export rule or an application-code change.

## Production inputs

- `narration.json` and `narration.zh-CN.md`: the Chinese script and intended scene sequence.
- `audio/`: complete 48 kHz mono PCM narration segments and measured provenance.
- `production/`: the isolated fixture, capture, voice-generation, rendering and verification helpers.
- `delivery/`: the final movie, subtitles, chapter notes, preview and reports.

Downloaded tools, original stock music, speech-service request files, browser
profiles, databases, original capture frames and render caches remain in ignored
local scratch storage. They are not part of the video handoff. Previous training
videos and existing uncommitted work remain preserved.

Xiaoyi speech is generated through the pinned `edge-tts` request format. This
laptop uses Windows' native HTTPS/WebSocket implementation because the Python
network connection timed out. Certificate verification remains enabled. Only the
fictional narration text is submitted to the speech service. Speech is retained
whole, without time stretching or word cuts.

## Verification and review

The verification report records decoding, stream properties, subtitle timing,
speech preservation, audio levels, member-role evidence and CSV/VIN associations.
Automated signal and speech-recognition checks are separate from human listening.
Reports identify which checks were actually performed; they do not claim a human
review that did not occur. The [review notes](delivery/review-notes.md) distinguish
the assistant's sampled visual inspection from continuous human viewing or
listening, and identify the labeled production overlays used for CSV evidence
and the actual shutdown result.

The video is a media deliverable based on a published application version. It is
not a new application release package.
