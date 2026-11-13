"""Check source speech with signal measurements and optional offline ASR.

ASR is independent automated evidence; it does not constitute human listening.
Only derived 16 kHz recognition inputs and logs are written to scratch.
"""
from __future__ import annotations

import argparse
import difflib
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys

from synthesize_training import measure


def normalized(text):
    return re.sub(r"[^\u3400-\u9fffA-Za-z0-9]", "", text).lower()


def distance(left, right):
    row = list(range(len(right) + 1))
    for i, char in enumerate(left):
        following = [i + 1]
        for j, other in enumerate(right):
            following.append(min(following[-1] + 1, row[j + 1] + 1, row[j] + (char != other)))
        row = following
    return row[-1]


def main(args):
    manifest = json.loads(args.manifest.read_text(encoding="utf-8-sig"))
    recordings = json.loads((args.audio / "audio-manifest.json").read_text(encoding="utf-8-sig"))
    records = {row["id"]: row for row in recordings["segments"]}
    args.scratch.mkdir(parents=True, exist_ok=True)
    rows = []
    for cue in manifest["cues"]:
        wav = args.audio / cue["audio"]
        if hashlib.sha256(wav.read_bytes()).hexdigest() != records[cue["id"]]["sha256"]:
            raise ValueError("Speech source changed")
        rows.append({"id": cue["id"], "spokenText": cue.get("tts", cue["text"]), **measure(wav)})
    if args.asr:
        ffmpeg = args.tools_root / "ffmpeg-9.0.2-essentials_build/bin/ffmpeg.exe"
        model = args.tools_root / "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17"
        executable = args.tools_root / "sherpa-onnx-v1.13.8-win-x64-shared-MT-Release/bin/sherpa-onnx-offline.exe"
        inputs = []
        for cue in manifest["cues"]:
            recognition_wav = args.scratch / (cue["id"] + "-16k.wav")
            subprocess.run([str(ffmpeg), "-v", "error", "-y", "-i", str(args.audio / cue["audio"]),
                            "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", str(recognition_wav)],
                           check=True, creationflags=subprocess.CREATE_NO_WINDOW)
            inputs.append(str(recognition_wav))
        command = [str(executable), "--debug=0", "--provider=cpu", "--num-threads=2",
                   "--sense-voice-language=zh", "--sense-voice-use-itn=0",
                   "--sense-voice-model=" + str(model / "model.int8.onnx"),
                   "--tokens=" + str(model / "tokens.txt"), *inputs]
        result = subprocess.run(command, capture_output=True, encoding="utf-8", errors="replace", timeout=240,
                                creationflags=subprocess.CREATE_NO_WINDOW)
        (args.scratch / "asr-run.log").write_text(result.stdout + "\nSTDERR\n" + result.stderr, encoding="utf-8")
        if result.returncode:
            raise ValueError("Offline ASR failed; see scratch/asr-run.log")
        transcripts = [json.loads(line) for line in result.stdout.splitlines() if line.startswith('{"lang"') or line.startswith('{"text"')]
        if len(transcripts) != len(rows):
            raise ValueError(f"Expected {len(rows)} ASR transcripts, received {len(transcripts)}")
        for row, transcript in zip(rows, transcripts):
            row["recognizedText"] = transcript["text"]
            expected, recognized = normalized(row["spokenText"]), normalized(transcript["text"])
            row["characterErrorRate"] = round(distance(expected, recognized) / max(1, len(expected)), 4)
            row["differences"] = [item for item in difflib.ndiff(list(expected), list(recognized)) if not item.startswith(" ")]
    summary = {"voice": recordings["voice"], "sourceCommit": manifest["sourceCommit"], "version": manifest["version"],
               "cueCount": len(rows), "totalSpeechSeconds": sum(row["duration"] for row in rows),
               "clippedSamples": sum(row["clippedSamples"] for row in rows),
               "asrPerformed": args.asr, "humanListeningPerformed": False,
               "asrReviewIds": [row["id"] for row in rows if row.get("characterErrorRate", 0) > .2]}
    (args.audio / "audio-qa.json").write_text(json.dumps({"summary": summary, "cues": rows}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    base = Path(__file__).resolve().parent.parent
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, default=base / "narration.json")
    parser.add_argument("--audio", type=Path, default=base / "audio")
    parser.add_argument("--tools-root", type=Path, default=base.parents[2] / "vehicle-manager-training/tools")
    parser.add_argument("--scratch", type=Path, required=True)
    parser.add_argument("--asr", action="store_true")
    main(parser.parse_args())
