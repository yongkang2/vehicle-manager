"""Generate the fictional member-training script with the specified Xiaoyi voice.

Dependencies are supplied through an isolated --packages directory. Speech is
never sped up or cut to fit the picture; measured durations drive scene holds.
Only the public fictional narration is sent to the online TTS service.
"""
from __future__ import annotations

import argparse
from array import array
import asyncio
from datetime import datetime, timezone
import hashlib
import importlib.metadata
import json
import math
from pathlib import Path
import subprocess
import sys
import wave


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")


def measure(path):
    with wave.open(str(path), "rb") as source:
        channels, width, rate = source.getnchannels(), source.getsampwidth(), source.getframerate()
        count = source.getnframes()
        if (channels, width, rate) != (1, 2, 48000):
            raise ValueError("Expected 48 kHz mono 16-bit PCM")
        samples = array("h", source.readframes(count))
    if sys.byteorder != "little":
        samples.byteswap()
    peak = max(abs(sample) for sample in samples) / 32768
    rms = math.sqrt(sum((sample / 32768) ** 2 for sample in samples) / len(samples))
    threshold = 32768 * 10 ** (-45 / 20)
    active = [index for index, sample in enumerate(samples) if abs(sample) >= threshold]
    if not active or rms < 10 ** (-40 / 20):
        raise ValueError("Silent or implausibly quiet narration")
    return {"duration": count / rate, "samples": count, "sampleRate": rate,
            "channels": channels, "sampleWidthBytes": width,
            "peakDbFS": 20 * math.log10(max(peak, 1e-12)),
            "rmsDbFS": 20 * math.log10(max(rms, 1e-12)),
            "clippedSamples": sum(abs(sample) >= 32760 for sample in samples),
            "leadingQuietSeconds": active[0] / rate,
            "trailingQuietSeconds": (len(samples) - active[-1] - 1) / rate}


async def main(args):
    if args.packages:
        sys.path.insert(0, str(args.packages.resolve()))
    import edge_tts
    raw_manifest = args.manifest.read_bytes()
    manifest = json.loads(raw_manifest.decode("utf-8-sig"))
    if manifest["voice"] != "zh-CN-XiaoyiNeural":
        raise ValueError("This production requires the specified Xiaoyi voice")
    manifest_sha = hashlib.sha256(raw_manifest).hexdigest()
    args.out.mkdir(parents=True, exist_ok=True)
    args.cache.mkdir(parents=True, exist_ok=True)
    output_manifest = args.out / "audio-manifest.json"
    rows = []
    if output_manifest.exists():
        existing = json.loads(output_manifest.read_text(encoding="utf-8-sig"))
        if existing["manifestSha256"] != manifest_sha or existing["voice"] != manifest["voice"]:
            raise ValueError("Existing narration belongs to a different script or voice")
        rows = existing["segments"]
    selected = set(args.segments or [cue["id"] for cue in manifest["cues"]])
    for cue in manifest["cues"]:
        identifier = cue["id"]
        if identifier not in selected:
            continue
        wav = args.out / cue["audio"]
        original = args.cache / f"{identifier}.mp3"
        previous = next((row for row in rows if row["id"] == identifier), None)
        if previous and wav.is_file() and digest(wav) == previous["sha256"]:
            print(json.dumps({"id": identifier, "stage": "retained", "duration": previous["duration"]}), flush=True)
            continue
        text = cue.get("tts", cue["text"])
        boundaries = []
        speech = edge_tts.Communicate(text, manifest["voice"], rate="+0%", pitch="+0Hz", volume="+0%",
                                     connect_timeout=20, receive_timeout=45)
        print(json.dumps({"id": identifier, "stage": "synthesis", "voice": manifest["voice"]}), flush=True)
        async def save():
            with original.open("wb") as target:
                async for chunk in speech.stream():
                    if chunk["type"] == "audio":
                        target.write(chunk["data"])
                    else:
                        boundaries.append(chunk)
        await asyncio.wait_for(save(), timeout=100)
        subprocess.run([str(args.ffmpeg), "-hide_banner", "-v", "error", "-y", "-i", str(original),
                        "-ac", "1", "-ar", "48000", "-c:a", "pcm_s16le", str(wav)],
                       check=True, creationflags=subprocess.CREATE_NO_WINDOW)
        measurements = measure(wav)
        row = {"id": identifier, "wav": wav.name, "audio": wav.name, "text": text,
               "captionText": cue["text"], "voice": manifest["voice"], "rate": "+0%", "pitch": "+0Hz",
               "targetSeconds": cue["targetSeconds"], "fitsTarget": measurements["duration"] <= cue["targetSeconds"] - .16,
               "sha256": digest(wav), "originalMp3Sha256": digest(original),
               "boundaries": boundaries, **measurements}
        rows = sorted([item for item in rows if item["id"] != identifier] + [row], key=lambda item: item["id"])
        metadata = {"generatedAt": datetime.now(timezone.utc).isoformat(), "service": "Microsoft Edge online text-to-speech",
                    "voice": manifest["voice"], "rate": "+0%", "pitch": "+0Hz", "volume": "+0%",
                    "edgeTtsVersion": importlib.metadata.version("edge-tts"), "sourceCommit": manifest["sourceCommit"],
                    "version": manifest["version"], "manifestSha256": manifest_sha,
                    "sampleRate": 48000, "channels": 1, "sampleWidthBytes": 2,
                    "humanRecording": False, "humanListeningPerformed": False, "timeStretching": False, "wordCuts": False,
                    "totalSpeechSeconds": sum(item["duration"] for item in rows), "segments": rows}
        write_json(output_manifest, metadata)
        write_json(args.out / "signal-qa.json", {"humanListeningPerformed": False,
                   "voice": manifest["voice"], "timeStretching": False, "wordCuts": False,
                   "totalSpeechSeconds": metadata["totalSpeechSeconds"],
                   "clippedSamples": sum(item["clippedSamples"] for item in rows),
                   "segments": [{key: item[key] for key in ["id", "duration", "fitsTarget", "peakDbFS", "rmsDbFS", "clippedSamples"]} for item in rows]})
        print(json.dumps({key: row[key] for key in ["id", "duration", "fitsTarget", "peakDbFS", "clippedSamples"]}), flush=True)


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, default=Path(__file__).resolve().parent.parent / "narration.json")
    parser.add_argument("--packages", type=Path, required=True)
    parser.add_argument("--ffmpeg", type=Path, required=True)
    parser.add_argument("--cache", type=Path, required=True)
    parser.add_argument("--out", type=Path, default=Path(__file__).resolve().parent)
    parser.add_argument("--segments", nargs="+")
    asyncio.run(main(parser.parse_args()))
