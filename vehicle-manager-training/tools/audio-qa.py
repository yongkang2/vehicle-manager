"""Signal and optional offline-ASR checks; these do not claim human listening."""
from __future__ import annotations
import argparse
import difflib
import json
import math
from pathlib import Path
import re
import subprocess
import sys
import wave
import numpy as np

ROOT = Path(__file__).resolve().parent.parent


def db(value):
    return round(20 * math.log10(max(value, 1e-12)), 3)


def normalize(text):
    return re.sub(r"[^\u3400-\u9fffA-Za-z0-9]", "", text).lower()


def distance(a, b):
    row = list(range(len(b) + 1))
    for i, left in enumerate(a):
        nxt = [i + 1]
        for j, right in enumerate(b):
            nxt.append(min(nxt[-1] + 1, row[j + 1] + 1, row[j] + (left != right)))
        row = nxt
    return row[-1]


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser()
    parser.add_argument("--asr", action="store_true")
    args = parser.parse_args()
    narration = json.loads((ROOT / "production/narration.json").read_text(encoding="utf-8-sig"))
    cues = narration["cues"]
    directory = ROOT / "production/audio"
    rows = []
    for cue in cues:
        path = directory / (str(cue["id"]) + ".wav")
        with wave.open(str(path)) as wav:
            if wav.getnchannels() != 1 or wav.getsampwidth() != 2:
                raise ValueError(f"Unexpected PCM format: {path}")
            rate, count = wav.getframerate(), wav.getnframes()
            samples = np.frombuffer(wav.readframes(count), dtype="<i2").astype(np.float64) / 32768
        peak, rms = float(np.max(np.abs(samples))), float(np.sqrt(np.mean(samples ** 2)))
        clipped = int(np.count_nonzero(np.abs(samples) >= 32760 / 32768))
        block = max(1, rate // 50)
        frames = [float(np.sqrt(np.mean(samples[i:i+block] ** 2))) for i in range(0, len(samples), block)]
        active = [i for i, amplitude in enumerate(frames) if amplitude >= 10 ** (-45 / 20)]
        longest, current = 0, 0
        if active:
            for amplitude in frames[active[0]:active[-1] + 1]:
                current = current + 1 if amplitude < 10 ** (-45 / 20) else 0
                longest = max(longest, current)
        row = {"id": str(cue["id"]), "duration": count / rate, "sampleRate": rate,
               "peakDbFS": db(peak), "rmsDbFS": db(rms), "clippedSamples": clipped,
               "leadingQuietSeconds": active[0] / 50 if active else count / rate,
               "trailingQuietSeconds": (len(frames) - 1 - active[-1]) / 50 if active else count / rate,
               "longestInternalQuietSeconds": longest / 50,
               "tts": cue.get("tts", cue["text"]), "path": str(path)}
        rows.append(row)
    if args.asr:
        model = ROOT / "tools/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17"
        executable = ROOT / "tools/sherpa-onnx-v1.13.8-win-x64-shared-MT-Release/bin/sherpa-onnx-offline.exe"
        command = [str(executable), "--debug=0", "--provider=cpu", "--num-threads=2",
                   "--sense-voice-language=zh", "--sense-voice-use-itn=0",
                   "--sense-voice-model=" + str(model / "model.int8.onnx"),
                   "--tokens=" + str(model / "tokens.txt"), *[x["path"] for x in rows]]
        run = subprocess.run(command, capture_output=True, encoding="utf-8", errors="replace", timeout=180)
        (directory / "asr-run.log").write_text(run.stdout + "\nSTDERR\n" + run.stderr, encoding="utf-8")
        if run.returncode:
            raise RuntimeError(f"ASR exit code {run.returncode}; inspect asr-run.log")
        transcripts = [json.loads(line) for line in run.stdout.splitlines() if line.startswith('{"lang"') or line.startswith('{"text"')]
        if len(transcripts) != len(rows):
            raise RuntimeError(f"Expected {len(rows)} ASR transcripts, got {len(transcripts)}; inspect asr-run.log")
        for row, transcript in zip(rows, transcripts):
            row["recognized"] = transcript["text"]
            expected, recognized = normalize(row["tts"]), normalize(row["recognized"])
            row["characterErrorRate"] = round(distance(expected, recognized) / max(1, len(expected)), 4)
            row["differences"] = [x for x in difflib.ndiff(list(expected), list(recognized)) if not x.startswith(" ")]
    summary = {"humanListeningPerformed": False, "voice": "Kokoro zf_xiaobei sid45, Mandarin female",
               "cueCount": len(rows), "totalAudioSeconds": sum(x["duration"] for x in rows),
               "clippedSamples": sum(x["clippedSamples"] for x in rows),
               "peakDbFS": max(x["peakDbFS"] for x in rows),
               "rmsDbFSRange": [min(x["rmsDbFS"] for x in rows), max(x["rmsDbFS"] for x in rows)],
               "recommendedMinTimelineSeconds": sum(max(cue["minDuration"], row["duration"] + .35) for cue, row in zip(cues, rows)),
               "signalWarnings": [x["id"] for x in rows if x["clippedSamples"] or x["longestInternalQuietSeconds"] > 1 or x["rmsDbFS"] < -35],
               "asrPerformed": args.asr,
               "asrReviewIds": [x["id"] for x in rows if x.get("characterErrorRate", 0) > .2]}
    report = {"summary": summary, "cues": rows}
    (directory / "audio-qa.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False))
    if args.asr:
        for row in rows:
            if row["characterErrorRate"] > .1:
                print(json.dumps({k: row[k] for k in ["id", "tts", "recognized", "characterErrorRate"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
