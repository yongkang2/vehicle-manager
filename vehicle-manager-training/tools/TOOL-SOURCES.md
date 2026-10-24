# Portable media tools used for this training video

No global installation, Windows locale changes, cloud TTS API, or paid service is used.

| Component | Official source | Download SHA-256 |
| --- | --- | --- |
| sherpa-onnx v1.13.8 Windows x64 shared MT Release, TTS enabled | https://github.com/k2-fsa/sherpa-onnx/releases/tag/v1.13.8 | `6dffdc715a4465b989446a6105265d2cb345e7101591a17d35534b6758f6e8df` |
| Kokoro multilingual v1.0 model | https://github.com/k2-fsa/sherpa-onnx/releases/tag/tts-models | `c5f7e2d2caf082bc1d20fb70334a61d99d20b484500aad32e7cf84c128ea3298` |
| FFmpeg 9.0.2 Essentials Windows ZIP | https://www.gyan.dev/ffmpeg/builds/ (linked by https://www.ffmpeg.org/download.html) | `60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba` |
| SenseVoice int8 multilingual 2024-07-17, optional automated QA | https://github.com/k2-fsa/sherpa-onnx/releases/tag/asr-models | `7d1efa2138a65b0b488df37f8b89e3d91a60676e416f515b952358d83dfd347e` |

Narration uses the supplied Kokoro speaker `zf_xiaobei`, SID 45, as documented in https://k2-fsa.github.io/sherpa/onnx/tts/pretrained_models/kokoro.html .
The downloaded model and FFmpeg folders retain their supplied license/README files. Kokoro model is Apache-2.0; FFmpeg Essentials binary is GPLv3. This folder is a local production tool cache and is not intended to be bundled into the application or final video handoff. See individual package notices for component terms.

`synthesize.py` calls the official native C API through Python stdlib ctypes. The stock Windows executable mangles Chinese positional arguments on this machine's non-UTF8 system locale, so direct UTF-8 C API input is used instead. Header layouts are read from the exact checksum-verified runtime package.

Example:

```powershell
python -B .\tools\synthesize.py --manifest .\production\narration.json --out .\production\audio
python -B .\tools\audio-qa.py --asr
```

Automated ASR and signal checks do not constitute human listening or guarantee every pronunciation.
