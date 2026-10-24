# Chinese member training video

This folder is intentionally tracked in Git. The video demonstrates the fixed
`main` commit `35eaa055f2bcd52e1ff588d6f1e6a7ce982931ff`, not every feature on the
current development branch. It is 3:45, 1920×1080, with Mandarin female narration
and Simplified Chinese subtitles. Administrator-only operations are not shown.

## Watch and use

- [Training video](delivery/车辆数据管理-普通成员快速入门.mp4)
- [Separate SRT subtitles](delivery/车辆数据管理-普通成员快速入门.srt)
- [Chinese script and actual chapter times](delivery/讲稿与章节.md)
- [Production notes and verification](delivery/制作说明.md)
- [Preview image](delivery/视频预览.png)
- [Delivery SHA-256 checksums](delivery/SHA256SUMS.txt)

All accounts, vehicles, attachments, and DOVE reports shown are fictional. The
recording used an approved ordinary member in an isolated local environment.
Audio signal/ASR checks and full media decoding passed; these do not replace human
listening. Listen to the complete video before publishing it to a team.

## Tracked production material

- `production/narration.json`: editable subtitle, voice, and scene instructions.
- `production/audio/`: all 44 final WAV segments, synthesis manifest, and original
  automated signal/ASR report. Paths in those reports describe the original local
  production run; the renderer uses WAVs next to the tracked manifest.
- `production/fixtures/`: two fictional DOVE workbooks used in the demonstration.
- `production/*.mjs`: reference browser-capture workflows.
- `production/render.py`: renderer, subtitle writer, and delivery QA.
- `tools/*.py` and `tools/TOOL-SOURCES.md`: local voice-generation/QA source and
  portable-tool versions, sources, checksums, and license notes.

The original sibling folder `../../vehicle-manager-training` outside the repository
is retained locally. The copy in this repository contains the curated materials
above, not a duplicate application installation or private runtime state.

## Reproduction limitations and safety

These are reference production scripts, not a one-command demo installer.
Original browser frames and render intermediates are intentionally not tracked;
rebuilding the picture requires recording all 44 scenes again. Downloaded FFmpeg,
sherpa-onnx, Kokoro and optional SenseVoice packages are also not tracked. Use the
versions and hashes in [tool sources](tools/TOOL-SOURCES.md), retaining their
license files. Rendering requires Windows, Microsoft YaHei, Python with Pillow,
and portable FFmpeg. Audio QA additionally requires NumPy. Browser capture uses
Node and the repository's installed dependencies.

Use a separate checkout of the pinned application version and **fictional data
only**. Prepare a disposable demo service on `127.0.0.1:14410` and a dedicated
browser profile with debugging on `127.0.0.1:19422`; never use a personal browser
profile, real shared folder, live service, or production database. The scripts
expect the original synthetic accounts, vehicles and starting UI state and can
write demo records, log in/out, and temporarily rename the demo share to show
offline behavior. Do not run them against an existing live session.

The first capture flow needs an off-camera approval step. The original temporary
helper is not included. Set `TRAINING_APPROVAL_HELPER` to your own reviewed Node
helper for the disposable demo environment before running flow 1. The script
fails before recording if this is missing. Demo passwords embedded in capture
flows are deliberately fictional and must never be used for real accounts.

Temporary databases, browser profiles, shared-folder state, downloaded binaries
and models, logs, original frame caches, and render caches remain ignored by the
folder's `.gitignore`. The delivered MP4/SRT/docs, narration audio and sources are
not ignored. The `.gitattributes` file preserves delivery bytes for checksum
verification across platforms.
