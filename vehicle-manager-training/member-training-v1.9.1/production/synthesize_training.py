"""Create complete normal-speed Xiaoyi utterances and verify their PCM sources.

Dependencies and service MP3 files stay in the supplied scratch directories.
--from-mp3 converts speech produced by the same service through Windows HTTPS.
No application data is read or changed, and speech is never cut or stretched.
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
import os
from pathlib import Path
import subprocess
import sys
import wave


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8-sig"))


def write_json(path, value):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def measure(path):
    with wave.open(str(path), "rb") as wav:
        channels, width, rate = wav.getnchannels(), wav.getsampwidth(), wav.getframerate()
        samples = wav.getnframes()
        if (channels, width, rate) != (1, 2, 48000):
            raise ValueError("Speech must be 48 kHz mono 16-bit PCM")
        values = array("h", wav.readframes(samples))
    if sys.byteorder != "little":
        values.byteswap()
    peak = max(abs(x) for x in values) / 32768
    rms = math.sqrt(sum((x / 32768) ** 2 for x in values) / len(values))
    if not peak or rms < 10 ** (-45 / 20):
        raise ValueError("Speech is silent or implausibly quiet")
    threshold = 32768 * 10 ** (-45 / 20)
    active = [i for i, x in enumerate(values) if abs(x) >= threshold]
    return {"samples": samples, "duration": samples / rate, "sampleRate": rate,
            "channels": channels, "sampleWidthBytes": width,
            "peakDbFS": 20 * math.log10(max(peak, 1e-12)),
            "rmsDbFS": 20 * math.log10(max(rms, 1e-12)),
            "clippedSamples": sum(abs(x) >= 32760 for x in values),
            "leadingQuietSeconds": active[0] / rate,
            "trailingQuietSeconds": (samples - active[-1] - 1) / rate}


def native_windows_speech(args):
    """Use the standard Windows TLS implementation without changing policy."""
    if os.name != "nt":
        raise ValueError("Native Windows speech transport requires Windows")
    from prepare_native_requests import main as prepare_native_requests
    request_file = args.source / "native-requests.json"
    prepare_native_requests(argparse.Namespace(packages=args.packages, manifest=args.manifest,
                                             out=request_file, segments=args.segments))
    quote = lambda value: "'" + str(Path(value).resolve()).replace("'", "''") + "'"
    source = Path(__file__).with_name("NativeSpeech.cs")
    command = (
        "$ErrorActionPreference='Stop'; "
        "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; "
        f"Add-Type -TypeDefinition (Get-Content -Raw -Encoding UTF8 -LiteralPath {quote(source)}); "
        f"$requests=Get-Content -Raw -Encoding UTF8 -LiteralPath {quote(request_file)} | ConvertFrom-Json; "
        "foreach($entry in $requests){ "
        f"$destination=Join-Path {quote(args.source)} ($entry.id+'.mp3'); "
        "$names=[string[]]@($entry.headers.PSObject.Properties.Name); "
        "$values=[string[]]@($entry.headers.PSObject.Properties.Value); "
        "[TrainingNativeSpeech]::Run($entry.url,$names,$values,[string[]]$entry.messages,$destination); "
        "Write-Output ('Complete Xiaoyi utterance '+$entry.id) }"
    )
    subprocess.run(["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
                   check=True, creationflags=subprocess.CREATE_NO_WINDOW)


async def main(args):
    if args.packages:
        sys.path.insert(0, str(args.packages.resolve()))
    import edge_tts
    manifest_bytes = args.manifest.read_bytes()
    manifest = json.loads(manifest_bytes.decode("utf-8-sig"))
    if manifest["voice"] != "zh-CN-XiaoyiNeural":
        raise ValueError("The approved voice must remain Xiaoyi")
    sha = hashlib.sha256(manifest_bytes).hexdigest()
    args.out.mkdir(parents=True, exist_ok=True)
    args.source.mkdir(parents=True, exist_ok=True)
    if args.native_windows:
        if not args.packages:
            raise ValueError("--native-windows requires the isolated pinned voice packages")
        native_windows_speech(args)
        args.from_mp3 = True
    output = args.out / "audio-manifest.json"
    previous = read_json(output) if output.exists() else None
    if previous and (previous["manifestSha256"] != sha or previous["voice"] != manifest["voice"]):
        raise ValueError("Existing recordings belong to a different narration manifest")
    rows = {x["id"]: x for x in previous.get("segments", [])} if previous else {}
    selected = set(args.segments.split(",")) if args.segments else None
    for cue in manifest["cues"]:
        identifier, spoken = cue["id"], cue.get("tts", cue["text"])
        if selected is not None and identifier not in selected:
            continue
        if not identifier.isdigit() or len(identifier) != 2:
            raise ValueError("Unsafe cue identifier")
        mp3, wav = args.source / (identifier + ".mp3"), args.out / cue["audio"]
        old = rows.get(identifier)
        if old and wav.is_file() and mp3.is_file() and old["sha256"] == digest(wav) and old.get("sourceMp3Sha256") == digest(mp3):
            print(f"Verified existing cue {identifier}", flush=True)
            continue
        if not args.from_mp3:
            speech = edge_tts.Communicate(spoken, manifest["voice"], rate="+0%", pitch="+0Hz", volume="+0%", connect_timeout=15, receive_timeout=30)
            boundaries = []
            async def save():
                with mp3.open("wb") as target:
                    async for chunk in speech.stream():
                        if chunk["type"] == "audio":
                            target.write(chunk["data"])
                        else:
                            boundaries.append(chunk)
            await asyncio.wait_for(save(), timeout=90)
            write_json(args.source / (identifier + ".boundaries.json"), boundaries)
        if not mp3.is_file() or mp3.stat().st_size < 1024:
            raise ValueError(f"Missing or empty complete service utterance {identifier}")
        command = [str(args.ffmpeg), "-hide_banner", "-v", "error", "-y", "-i", str(mp3),
                   "-ac", "1", "-ar", "48000", "-c:a", "pcm_s16le", str(wav)]
        subprocess.run(command, check=True, creationflags=subprocess.CREATE_NO_WINDOW)
        measurements = measure(wav)
        rows[identifier] = {"id": identifier, "text": spoken, "captionText": cue["text"],
                            "wav": wav.name, "sha256": digest(wav), "sourceMp3Sha256": digest(mp3),
                            "rate": "+0%", "pitch": "+0Hz", "timeStretching": False,
                            "wordCuts": False, **measurements}
        report = {"generatedAt": datetime.now(timezone.utc).isoformat(),
                  "sourceCommit": manifest["sourceCommit"], "version": manifest["version"],
                  "manifestSha256": sha, "voice": manifest["voice"],
                  "service": "Microsoft Edge online text-to-speech",
                  "transport": "native Windows WebSocket" if args.from_mp3 else "edge-tts aiohttp WebSocket",
                  "edgeTtsVersion": importlib.metadata.version("edge-tts"),
                  "humanRecording": False, "humanListeningPerformed": False,
                  "timeStretching": False, "wordCuts": False,
                  "segments": sorted(rows.values(), key=lambda row: row["id"])}
        write_json(output, report)
        print(json.dumps({"id": identifier, "duration": measurements["duration"], "peakDbFS": measurements["peakDbFS"], "clippedSamples": measurements["clippedSamples"]}), flush=True)
    all_rows = sorted(rows.values(), key=lambda row: row["id"])
    print(json.dumps({"segments": len(all_rows), "totalSpeechSeconds": sum(row["duration"] for row in all_rows),
                      "expectedVideoSeconds": sum(max(float(cue["targetSeconds"]), rows.get(cue["id"], {}).get("duration", 0) + .35) for cue in manifest["cues"])}), flush=True)


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--ffmpeg", type=Path, required=True)
    parser.add_argument("--packages", type=Path)
    parser.add_argument("--segments")
    parser.add_argument("--from-mp3", action="store_true")
    parser.add_argument("--native-windows", action="store_true")
    asyncio.run(main(parser.parse_args()))
