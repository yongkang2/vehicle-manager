"""Independently verify the completed member training delivery.

Reads the movie, subtitles and retained production inputs. Derived analysis and
sample frames stay in the explicit cache; only the report/contact sheets are
written to the delivery folder. No application or browser access occurs here.
"""
from __future__ import annotations

import argparse
import csv
import io
from fractions import Fraction
import hashlib
import json
import math
from pathlib import Path
import re
import subprocess
import sys
import wave
import zipfile

import numpy as np
from PIL import Image, ImageDraw, ImageFont

SOURCE = "6f9354ac76e7999e9a115ad6aa95417366f01a0a"
VERSION = "1.9.1"
NAME = "vehicle-manager-member-training-v1.9.1-zh-CN"
BASE = Path(__file__).resolve().parent.parent
REPO = BASE.parent.parent
RATE = 48000


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8-sig"))


def digest(path):
    with Path(path).open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def write_json(path, value):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")


def run(command, timeout=1200):
    result = subprocess.run([str(x) for x in command], capture_output=True,
                            encoding="utf-8", errors="replace", timeout=timeout)
    if result.returncode:
        raise RuntimeError(f"Command failed ({result.returncode}): {command[0]}\n{result.stderr[-5000:]}")
    return result


def seconds(value):
    hour, minute, second = value.split(":")
    return int(hour) * 3600 + int(minute) * 60 + float(second.replace(",", "."))


def normalized(value):
    return re.sub(r"\s", "", value)


def edit_distance(left, right):
    row = list(range(len(right) + 1))
    for left_index, character in enumerate(left, 1):
        following = [left_index]
        for right_index, other in enumerate(right, 1):
            following.append(min(following[-1] + 1, row[right_index] + 1,
                                 row[right_index - 1] + int(character != other)))
        row = following
    return row[-1]


def captions(path, cues, duration):
    rows = []
    blocks = re.split(r"\n\s*\n", path.read_text(encoding="utf-8-sig").strip())
    assert len(blocks) == len(cues), "SRT/cue counts differ"
    for number, (block, cue) in enumerate(zip(blocks, cues), 1):
        lines = block.splitlines()
        assert len(lines) in (3, 4), "Every subtitle needs one or two text lines"
        assert int(lines[0]) == number, "Subtitle numbering differs"
        match = re.fullmatch(r"(\d{2}:\d{2}:\d{2},\d{3}) --> (\d{2}:\d{2}:\d{2},\d{3})", lines[1])
        assert match, "Malformed SRT timing"
        start, end = seconds(match[1]), seconds(match[2])
        assert 0 <= start < end <= duration + .001, "Caption is outside the movie"
        assert abs(start - cue["start"]) <= .0006 and abs(end - cue["end"]) <= .0006, "Caption/timeline timing differs"
        assert normalized("".join(lines[2:])) == normalized(cue["text"]), "Caption words differ from the script"
        assert "\ufffd" not in "".join(lines[2:]), "Broken Chinese encoding"
        if rows:
            assert start >= rows[-1]["end"] - .0001, "Captions overlap"
        assert cue["start"] <= cue["speechStart"] < cue["speechEnd"] <= cue["end"], "Speech exceeds the caption scene"
        rows.append({"id": cue["id"], "start": start, "end": end, "lines": lines[2:]})
    return rows


def audio_checks(args, ffmpeg, cues, provenance):
    mono = args.cache / "decoded-final-mono.wav"
    run([ffmpeg, "-hide_banner", "-v", "error", "-y", "-i", args.video,
         "-vn", "-ac", "1", "-ar", RATE, "-c:a", "pcm_s16le", mono])
    with wave.open(str(mono), "rb") as source:
        assert (source.getnchannels(), source.getsampwidth(), source.getframerate()) == (1, 2, RATE)
        final = np.frombuffer(source.readframes(source.getnframes()), dtype="<i2").astype(np.float32) / 32768
    narration = args.render_cache / "narration.wav"
    with wave.open(str(narration), "rb") as source:
        raw = source.readframes(source.getnframes())
        assert (source.getnchannels(), source.getsampwidth(), source.getframerate()) == (1, 2, RATE)
    assert digest(narration) == provenance["mix"]["originalNarrationTimelineSha256"]
    original = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768
    rows = []
    for cue in cues:
        start = round(cue["start"] * RATE)
        speech_start = round(cue["speechStart"] * RATE)
        speech_end = speech_start + cue["speechSamples"]
        end = round(cue["end"] * RATE)
        original_path = args.audio_root / Path(cue["audioPath"]).name
        with wave.open(str(original_path), "rb") as source:
            original_bytes = source.readframes(source.getnframes())
        assert digest(original_path) == cue["audioSha256"]
        assert raw[speech_start * 2:speech_end * 2] == original_bytes, f"Voice was changed or cut: {cue['id']}"
        assert not any(raw[start * 2:speech_start * 2]) and not any(raw[speech_end * 2:end * 2]), "Speech padding is not silence"
        before, after = original[speech_start:speech_end], final[speech_start:speech_end]
        assert len(before) == len(after), "Final audio ends before a spoken cue"
        rms = float(np.sqrt(np.mean(after ** 2)))
        assert rms > 10 ** (-42 / 20), f"Final speech is implausibly quiet: {cue['id']}"
        correlation = float(np.corrcoef(before, after)[0, 1])
        assert math.isfinite(correlation) and correlation >= .85, f"Final mix does not match narration: {cue['id']} ({correlation:.3f})"
        rows.append({"id": cue["id"], "speechSamples": cue["speechSamples"],
                     "originalSpeechRetainedExactlyBeforeMix": True,
                     "finalMixCorrelation": correlation, "finalMixRmsDbFS": 20 * math.log10(rms)})

    # Decode both final channels without retaining a second complete array.
    command = [str(x) for x in [ffmpeg, "-v", "error", "-i", args.video,
                               "-vn", "-ac", "2", "-ar", RATE, "-f", "f32le", "-"]]
    process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    peak, energy, samples, clipped = 0.0, 0.0, 0, 0
    while True:
        data = process.stdout.read(1024 * 1024)
        if not data:
            break
        values = np.frombuffer(data, dtype="<f4")
        peak = max(peak, float(np.max(np.abs(values))))
        energy += float(np.sum(values.astype(np.float64) ** 2))
        samples += len(values)
        clipped += int(np.count_nonzero(np.abs(values) >= .999))
    error = process.stderr.read().decode("utf-8", "replace")
    assert process.wait(timeout=60) == 0, error
    assert samples and clipped == 0 and peak < .999, "Clipping detected in final stereo audio"
    assert provenance["mix"]["speechCuts"] is False and provenance["mix"]["speechTimeStretching"] is False
    assert provenance["mix"]["duckDb"] < 0 and provenance["mix"]["crossfadeSeconds"] > 0
    gain = 10 ** ((provenance["mix"]["voiceGainDb"] + provenance["mix"]["limiterGainDb"]) / 20)
    length = min(len(original), len(final))
    residual = final[:length] - original[:length] * gain
    residual_rms = float(np.sqrt(np.mean(residual ** 2)))
    assert residual_rms > 10 ** (-65 / 20), "No audible music residual found under narration"
    # Check each complete second between the intentional opening/closing fades.
    music_windows = [20 * math.log10(max(float(np.sqrt(np.mean(residual[i * RATE:(i + 1) * RATE] ** 2))), 1e-12))
                     for i in range(1, math.floor(length / RATE) - 2)]
    assert music_windows and min(music_windows) > -65, "A background-music interval is unexpectedly silent"
    return {"peakDbFS": 20 * math.log10(max(peak, 1e-12)),
            "rmsDbFS": 10 * math.log10(energy / samples), "clippedSamples": clipped,
            "decodedStereoSamples": samples, "musicResidualRmsDbFS": 20 * math.log10(residual_rms),
            "musicContinuity": {"passed": True, "windowSeconds": 1, "windowsChecked": len(music_windows),
                                "minimumResidualRmsDbFS": min(music_windows), "thresholdDbFS": -65,
                                "intentionalOpeningAndClosingFadesExcluded": True},
            "musicLoopStarts": provenance["mix"]["loopStarts"], "cues": rows}


def sample_frames(args, ffmpeg, timeline):
    font = ImageFont.truetype("C:/Windows/Fonts/msyh.ttc", 19)
    samples = []
    by_chapter = {}
    for cue in timeline["cues"]:
        for part, fraction in enumerate((.25, .8), 1):
            at = cue["start"] + (cue["end"] - cue["start"]) * fraction
            path = args.cache / f"scene-{cue['id']}-{part}.png"
            run([ffmpeg, "-hide_banner", "-v", "error", "-y", "-ss", str(at), "-i", args.video,
                 "-frames:v", "1", path])
            with Image.open(path) as image:
                assert image.size == (1920, 1080)
            row = {"id": cue["id"], "chapter": cue["chapter"], "time": at, "path": str(path)}
            samples.append(row)
            by_chapter.setdefault(cue["chapter"], []).append(row)
    sheets = []
    overview = Image.new("RGB", (1280, len(timeline["chapters"]) * 400), (24, 39, 77))
    overview_draw = ImageDraw.Draw(overview)
    for index, chapter in enumerate(timeline["chapters"]):
        items = by_chapter[chapter["id"]]
        chosen = (items[len(items) // 3], items[(len(items) * 2) // 3])
        for column, row in enumerate(chosen):
            with Image.open(row["path"]) as image:
                overview.paste(image.convert("RGB").resize((640, 360), Image.Resampling.LANCZOS), (640 * column, index * 400 + 40))
            overview_draw.text((640 * column + 12, index * 400 + 10), f"{chapter['title']} / {row['time']:.2f}s", font=font, fill="white")
        sheet = Image.new("RGB", (1280, math.ceil(len(items) / 2) * 400), (24, 39, 77))
        draw = ImageDraw.Draw(sheet)
        for item_index, row in enumerate(items):
            column, line = item_index % 2, item_index // 2
            with Image.open(row["path"]) as image:
                sheet.paste(image.convert("RGB").resize((640, 360), Image.Resampling.LANCZOS), (640 * column, line * 400 + 40))
            draw.text((640 * column + 12, line * 400 + 10), f"Cue {row['id']} / {row['time']:.2f}s", font=font, fill="white")
        sheet_path = args.out / f"contact-sheet-{chapter['id']}.jpg"
        sheet.save(sheet_path, quality=92)
        sheets.append(str(sheet_path))
    overview_path = args.out / "contact-sheet.jpg"
    overview.save(overview_path, quality=94)
    return samples, str(overview_path), sheets


def optional_asr(args, ffmpeg, cues):
    if not args.asr:
        return []
    model = args.tools_root / "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17"
    executable = args.tools_root / "sherpa-onnx-v1.13.8-win-x64-shared-MT-Release/bin/sherpa-onnx-offline.exe"
    wavs = []
    for cue in cues:
        target = args.cache / f"asr-{cue['id']}.wav"
        run([ffmpeg, "-v", "error", "-y", "-ss", cue["speechStart"], "-i", args.video,
             "-t", cue["speechEnd"] - cue["speechStart"], "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", target])
        wavs.append(target)
    result = run([executable, "--debug=0", "--provider=cpu", "--num-threads=2", "--sense-voice-language=zh",
                  "--sense-voice-use-itn=0", "--sense-voice-model=" + str(model / "model.int8.onnx"),
                  "--tokens=" + str(model / "tokens.txt"), *wavs])
    (args.cache / "asr.log").write_text(result.stdout + "\nSTDERR\n" + result.stderr, encoding="utf-8")
    results = [json.loads(line) for line in result.stdout.splitlines() if line.startswith('{"lang"') or line.startswith('{"text"')]
    assert len(results) == len(cues), "ASR returned an unexpected utterance count"
    rows = []
    for cue, result in zip(cues, results):
        expected = cue.get("tts", cue["text"])
        left = re.sub(r"[^\u3400-\u9fffA-Za-z0-9]", "", expected).lower()
        right = re.sub(r"[^\u3400-\u9fffA-Za-z0-9]", "", result["text"]).lower()
        rate = edit_distance(left, right) / max(1, len(left))
        rows.append({"id": cue["id"], "expectedSpokenText": expected,
                     "recognized": result["text"], "characterErrorRate": rate,
                     "suggestedReview": rate > .2})
    return rows


def main():
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="backslashreplace")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--delivery", type=Path, default=BASE / "delivery")
    parser.add_argument("--video", type=Path)
    parser.add_argument("--srt", type=Path)
    parser.add_argument("--capture", type=Path, default=REPO / ".runtime/training-v1.9.1/capture/capture.json")
    parser.add_argument("--audio-root", type=Path, default=BASE / "audio")
    parser.add_argument("--render-cache", type=Path, default=REPO / ".runtime/training-v1.9.1/render")
    parser.add_argument("--cache", type=Path, default=REPO / ".runtime/training-v1.9.1/verification")
    parser.add_argument("--out", type=Path)
    parser.add_argument("--tools-root", type=Path, default=REPO.parent / "vehicle-manager-training/tools")
    parser.add_argument("--asr", action="store_true")
    args = parser.parse_args()
    args.video = args.video or args.delivery / f"{NAME}.mp4"
    args.srt = args.srt or args.delivery / f"{NAME}.srt"
    args.out = args.out or args.delivery
    args.cache.mkdir(parents=True, exist_ok=True)
    args.out.mkdir(parents=True, exist_ok=True)
    timeline = read_json(args.delivery / "timeline.json")
    provenance = read_json(args.delivery / "production-provenance.json")
    capture = read_json(args.capture)
    for source in (timeline, provenance, capture):
        assert source["sourceCommit"] == SOURCE and source.get("version", source.get("appVersion")) == VERSION
    assert capture["role"] == "member"
    assert provenance["videoSha256"] == digest(args.video)
    assert provenance["captureManifestSha256"] == digest(args.capture)
    tools = args.tools_root / "ffmpeg-9.0.2-essentials_build/bin"
    ffmpeg, ffprobe = tools / "ffmpeg.exe", tools / "ffprobe.exe"
    probe = json.loads(run([ffprobe, "-v", "error", "-count_frames", "-show_streams", "-show_format", "-show_chapters", "-of", "json", args.video]).stdout)
    videos = [row for row in probe["streams"] if row["codec_type"] == "video"]
    audios = [row for row in probe["streams"] if row["codec_type"] == "audio"]
    assert len(videos) == len(audios) == 1
    video, audio = videos[0], audios[0]
    duration = timeline["duration"]
    assert 180 <= duration <= 300 and abs(float(probe["format"]["duration"]) - duration) < .06
    assert video["codec_name"] == "h264" and video["pix_fmt"] == "yuv420p"
    assert (video["width"], video["height"]) == (1920, 1080)
    assert Fraction(video["avg_frame_rate"]) == 30 and int(video["nb_read_frames"]) == timeline["frames"]
    assert audio["codec_name"] == "aac" and int(audio["sample_rate"]) == RATE and audio["channels"] == 2
    assert len(probe["chapters"]) == len(timeline["chapters"])
    for actual, expected in zip(probe["chapters"], timeline["chapters"]):
        assert abs(float(actual["start_time"]) - expected["start"]) <= .002
        assert abs(float(actual["end_time"]) - expected["end"]) <= .002
    subtitle_rows = captions(args.srt, timeline["cues"], duration)
    decode = run([ffmpeg, "-hide_banner", "-v", "error", "-i", args.video, "-map", "0:v:0", "-map", "0:a:0", "-f", "null", "-"])
    assert not decode.stderr.strip(), "Full decode returned errors"
    signal = audio_checks(args, ffmpeg, timeline["cues"], provenance)
    samples, overview, sheets = sample_frames(args, ffmpeg, timeline)
    asr = optional_asr(args, ffmpeg, timeline["cues"])
    role_checks = capture.get("roleChecks", [])
    assert len(role_checks) >= 6, "Insufficient ordinary-member role evidence"
    for row in role_checks:
        cue_id = str(row.get("cueId", row.get("id", "")))
        if cue_id in {"01", "02", "03"} and row.get("access") != "approved":
            assert row.get("role") in (None, "member"), "Administrator session appeared during onboarding"
            assert row.get("access") in {"unconfigured", "pending", "unbound"}
        else:
            assert row.get("role") == "member" and row.get("access", "approved") == "approved"
        assert row.get("adminNavigationAbsent", True) is True
    evidence = capture.get("csvEvidence", {})
    assert evidence.get("verified") and evidence.get("vehicleVinColumnExplicitlySelected"), "Equipment VIN was not explicitly selected"
    archive = Path(evidence["zipPath"])
    assert digest(archive) == evidence["zipSha256"], "Downloaded CSV archive changed"
    with zipfile.ZipFile(archive) as packed:
        payload = packed.read("equipment.csv")
    assert hashlib.sha256(payload).hexdigest() == evidence["csvSha256"]
    exported = list(csv.reader(io.StringIO(payload.decode("utf-8-sig"))))
    assert exported[0] == evidence["headers"] and exported[1:] == evidence["rows"]
    index = exported[0].index("车辆 VIN")
    assert len(exported) > 1 and all(row[index] == evidence["vin"] for row in exported[1:]), "An equipment row has the wrong linked VIN"
    assert digest(Path(evidence["associationsPath"])) == evidence["associationsSha256"]
    association_doc = read_json(Path(evidence["associationsPath"]))
    assert association_doc["role"] == "member" and association_doc["sourceCommit"] == SOURCE
    name_index = exported[0].index("名称")
    type_index = exported[0].index("类型")
    for row in exported[1:]:
        assert any(item["name"] == row[name_index] and item["equipmentType"] == row[type_index] and item["vin"] == row[index] for item in association_doc["associations"]), "CSV row does not match the captured equipment-to-vehicle association"
    report = {"passed": True, "sourceCommit": SOURCE, "version": VERSION, "video": str(args.video),
              "sha256": digest(args.video), "duration": duration, "videoFrames": int(video["nb_read_frames"]),
              "width": 1920, "height": 1080, "fps": "30", "videoCodec": "h264", "pixelFormat": "yuv420p",
              "audioCodec": "aac", "audioSampleRate": RATE, "audioChannels": 2,
              "fullDecodePassed": True, "captionChecksPassed": True, "speechPreservationPassed": True,
              "signal": signal, "roleChecks": role_checks, "capturedRole": capture["role"],
              "equipmentCsvVinVerified": True, "equipmentCsvRows": len(exported)-1,
              "shutdownEvidence": capture.get("shutdownEvidence"),
              "sampleFrames": samples, "contactSheet": overview, "chapterContactSheets": sheets,
              "asr": asr, "humanListeningPerformed": False, "humanVisualReviewPerformed": False,
              "limitations": "Decoding, signal, timing, speech comparison and optional ASR checks do not replace complete human listening. Contact sheets require visual review for member-only UI and caption readability."}
    write_json(args.out / "verification.json", report)
    print(json.dumps({"passed": True, "duration": duration, "frames": timeline["frames"], "subtitles": len(subtitle_rows),
                      "minimumSpeechCorrelation": min(row["finalMixCorrelation"] for row in signal["cues"]),
                      "clippedSamples": signal["clippedSamples"], "contactSheet": overview}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
