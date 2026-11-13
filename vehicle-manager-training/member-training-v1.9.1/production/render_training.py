"""Render real member-interface captures and intact Mandarin speech; no app access.

Only delivery files and the explicit scratch directory are written. Downloaded
tools, original music, speech WAVs and captured UI frames are read-only inputs.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import math
from pathlib import Path
import subprocess
import sys
import wave
import zipfile

import numpy as np
from PIL import Image, ImageDraw, ImageFont

SOURCE = "6f9354ac76e7999e9a115ad6aa95417366f01a0a"
VERSION = "1.9.1"
MUSIC_SHA = "a7f05a29d07a84d38072ccd2b35204bca812db86e75b2a837e71cc144d3e739b"
FFMPEG_ZIP_SHA = "60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba"
WIDTH, HEIGHT, FPS, RATE = 1920, 1080, 30, 48000
NAVY, WHITE, QUIET = (24, 39, 77), (249, 251, 255), (191, 205, 226)
FONT = Path("C:/Windows/Fonts/msyh.ttc")
BASE = Path(__file__).resolve().parent.parent
REPO = BASE.parent.parent
TOOLS = REPO.parent / "vehicle-manager-training/tools"


def log(message):
    print(message, flush=True)


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8-sig"))


def write_text(path, text):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(text, encoding="utf-8", newline="\n")


def write_json(path, value):
    write_text(path, json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def digest(path):
    with Path(path).open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def run(command, log_path=None, timeout=1200, binary=False):
    result = subprocess.run([str(x) for x in command], capture_output=True,
                            timeout=timeout, **({} if binary else {"encoding": "utf-8", "errors": "replace"}))
    error = result.stderr.decode("utf-8", "replace") if binary else result.stderr
    if log_path:
        write_text(log_path, error)
    if result.returncode:
        raise RuntimeError(f"Command failed ({result.returncode}): {command[0]}\n{error[-5000:]}")
    return result


def quote(path):
    return "'" + str(Path(path).resolve()).replace("\\", "/").replace("'", "'\\''") + "'"


def stamp(seconds):
    whole, ms = divmod(round(seconds * 1000), 1000)
    hour, tail = divmod(whole, 3600)
    minute, second = divmod(tail, 60)
    return f"{hour:02}:{minute:02}:{second:02},{ms:03}"


def wrap_caption(text):
    font = ImageFont.truetype(str(FONT), 33)
    text = str(text).strip()
    if not text or "\ufffd" in text:
        raise ValueError("Caption is empty or contains a replacement character")
    if font.getlength(text) <= 1770:
        return [text]
    candidates = []
    for at in range(1, len(text)):
        if text[at - 1].isascii() and text[at].isascii() and text[at - 1].isalnum() and text[at].isalnum():
            continue
        left, right = text[:at].strip(), text[at:].strip()
        if max(font.getlength(left), font.getlength(right)) <= 1770:
            score = abs(font.getlength(left) - font.getlength(right))
            if text[at - 1] in "，。；：！？":
                score -= 200
            candidates.append((score, [left, right]))
    if not candidates:
        raise ValueError(f"Caption cannot fit two readable lines: {text}")
    return min(candidates, key=lambda item: item[0])[1]


def check_tools(tools):
    folder = tools / "ffmpeg-9.0.2-essentials_build"
    archive = tools / "ffmpeg-9.0.2-essentials_build.zip"
    if digest(archive) != FFMPEG_ZIP_SHA:
        raise ValueError("FFmpeg archive differs from approved tool provenance")
    hashes = {}
    with zipfile.ZipFile(archive) as packed:
        for name in ("ffmpeg.exe", "ffprobe.exe"):
            binary = folder / "bin" / name
            expected = [x for x in packed.namelist() if x.endswith("/bin/" + name)]
            if len(expected) != 1:
                raise ValueError("Unexpected FFmpeg archive layout")
            with packed.open(expected[0]) as source:
                approved = hashlib.file_digest(source, "sha256").hexdigest()
            if digest(binary) != approved:
                raise ValueError(f"{name} differs from the verified archive")
            hashes[name] = approved
    if not FONT.is_file():
        raise FileNotFoundError("Microsoft YaHei is required for Chinese captions")
    ffmpeg = folder / "bin/ffmpeg.exe"
    return ffmpeg, {"archiveSha256": FFMPEG_ZIP_SHA, "binaries": hashes,
                    "version": run([ffmpeg, "-version"]).stdout.splitlines()[0]}


def load_inputs(args):
    narration, manifest, capture = read_json(args.manifest), read_json(args.audio_manifest), read_json(args.capture)
    for name, item in (("narration", narration), ("audio manifest", manifest), ("capture", capture)):
        if item.get("sourceCommit") != SOURCE:
            raise ValueError(f"{name} source commit differs from the approved source")
        if item.get("version", item.get("appVersion")) != VERSION:
            raise ValueError(f"{name} version differs from {VERSION}")
    if manifest.get("manifestSha256") != digest(args.manifest):
        raise ValueError("Audio was synthesized from a different narration manifest")
    if capture.get("role") != "member":
        raise ValueError("Only ordinary-member interface captures are authorized")
    viewport = capture.get("viewport", {})
    if (viewport.get("width"), viewport.get("height")) != (WIDTH, HEIGHT):
        raise ValueError("Expected a complete 1920x1080 viewport capture")
    cues = narration["cues"]
    if not cues or len({str(c["id"]) for c in cues}) != len(cues):
        raise ValueError("Narration cue identifiers must be unique")
    recordings = {str(x["id"]): x for x in manifest["segments"]}
    capture_rows = capture.get("cues", capture.get("captures"))
    if not isinstance(capture_rows, list):
        raise ValueError("Capture manifest must contain cue recordings")
    captures = {str(x.get("id", x.get("name"))): x for x in capture_rows}
    if set(recordings) != {str(c["id"]) for c in cues} or set(captures) != set(recordings):
        raise ValueError("Narration, speech and capture cue identifiers differ")
    chapter_ids = [str(x["id"]) for x in narration["chapters"]]
    timeline, cursor, source_hash = [], 0, hashlib.sha256()
    for cue in cues:
        identifier = str(cue["id"])
        if str(cue["chapter"]) not in chapter_ids:
            raise ValueError(f"Unknown chapter: {identifier}")
        recording = recordings[identifier]
        audio = args.audio_root / recording.get("wav", cue["audio"])
        if digest(audio) != recording["sha256"]:
            raise ValueError(f"Speech SHA-256 differs: {identifier}")
        with wave.open(str(audio), "rb") as source:
            if (source.getnchannels(), source.getsampwidth(), source.getframerate()) != (1, 2, RATE):
                raise ValueError("Speech must be intact 48 kHz mono 16-bit PCM")
            samples = source.getnframes()
        seconds = samples / RATE
        if abs(recording["duration"] - seconds) > 1 / RATE or recording["samples"] != samples:
            raise ValueError(f"Speech duration differs from manifest: {identifier}")
        if recording.get("text") != cue.get("tts", cue["text"]) or recording.get("captionText") != cue["text"]:
            raise ValueError(f"Audio/caption script differs: {identifier}")
        frames = math.ceil(max(float(cue["targetSeconds"]), seconds + .35) * FPS - 1e-8)
        scene = captures[identifier]
        if scene["end"] <= scene["start"] or not scene.get("frames"):
            raise ValueError(f"Empty capture: {identifier}")
        previous_time = -math.inf
        for frame in scene["frames"]:
            filename = Path(frame["filename"])
            if frame["time"] < previous_time or frame["time"] < scene["start"] - 50 or frame["time"] > scene["end"] + 50:
                raise ValueError(f"Invalid capture timestamps: {identifier}")
            previous_time = frame["time"]
            if not filename.is_file():
                raise FileNotFoundError(filename)
            source_hash.update(digest(filename).encode("ascii"))
        lead = round(.12 * RATE)
        timeline.append({**cue, "id": identifier, "audioPath": str(audio.resolve()),
                         "audioSha256": recording["sha256"], "speechSamples": samples,
                         "leadSamples": lead, "paddingSamples": frames * (RATE // FPS) - samples - lead,
                         "start": cursor / FPS, "speechStart": cursor / FPS + lead / RATE,
                         "speechEnd": cursor / FPS + (lead + samples) / RATE,
                         "end": (cursor + frames) / FPS, "frameStart": cursor, "frameEnd": cursor + frames,
                         "frameCount": frames, "videoDuration": frames / FPS,
                         "captureFrameCount": len(scene["frames"]),
                         "captureDuration": (scene["end"] - scene["start"]) / 1000,
                         "capturePlaybackSpeed": max(1.0, (scene["end"] - scene["start"]) / 1000 / (frames / FPS)),
                         "captionLines": wrap_caption(cue["text"])})
        cursor += frames
    duration = cursor / FPS
    if not 180 <= duration <= 300:
        raise ValueError(f"Intact speech/scene holds require {duration:.3f}s, outside 3-5 minutes")
    chapters = []
    for chapter in narration["chapters"]:
        selected = [x for x in timeline if str(x["chapter"]) == str(chapter["id"])]
        if not selected:
            raise ValueError(f"Empty chapter: {chapter['id']}")
        if selected[-1]["end"] - selected[0]["start"] != sum(x["videoDuration"] for x in selected):
            if abs(selected[-1]["end"] - selected[0]["start"] - sum(x["videoDuration"] for x in selected)) > .001:
                raise ValueError("Chapter cues must be contiguous")
        chapters.append({**chapter, "start": selected[0]["start"], "end": selected[-1]["end"]})
    return narration, timeline, chapters, captures, source_hash.hexdigest()


def compose(filename, cue, chapter, shutdown_evidence=None):
    with Image.open(filename) as source:
        if source.size != (WIDTH, HEIGHT):
            raise ValueError(f"Captured UI viewport differs: {source.size}")
        ui = source.convert("RGB").resize((1600, 900), Image.Resampling.LANCZOS)
    canvas = Image.new("RGB", (WIDTH, HEIGHT), NAVY)
    canvas.paste(ui, (160, 64))
    draw = ImageDraw.Draw(canvas)
    if shutdown_evidence:
        if not shutdown_evidence.get("completed") or "Service stop requested" not in shutdown_evidence.get("output", ""):
            raise ValueError("Shutdown overlay requires completed real launcher evidence")
        draw.rectangle((320, 320, 1600, 724), fill=WHITE, outline=NAVY, width=3)
        title = ImageFont.truetype(str(FONT), 35)
        body = ImageFont.truetype(str(FONT), 28)
        output_font = ImageFont.truetype(str(FONT), 23)
        draw.text((360, 354), "安全退出：在完整解压目录运行 Stop.cmd", font=title, fill=NAVY)
        draw.text((360, 424), "培训注释：以下为本次演示实际执行的结果，不是应用内的新界面。", font=body, fill=NAVY)
        draw.rectangle((360, 490, 1560, 586), fill="#edf1f6")
        words, lines, line = shutdown_evidence["output"].split(), [], ""
        for word in words:
            candidate = (line + " " + word).strip()
            if output_font.getlength(candidate) > 1140:
                lines.append(line)
                line = word
            else:
                line = candidate
        lines.append(line)
        for index, text in enumerate(lines):
            draw.text((384, 504 + index * 34), text, font=output_font, fill=NAVY)
        draw.text((360, 632), "已确认演示服务正常关闭；请等待处理完成后再关闭窗口。", font=body, fill=NAVY)
    heading = f"{chapter} · {cue['title']}"
    size = 28
    title_font = ImageFont.truetype(str(FONT), size)
    while title_font.getlength(heading) > 1240 and size > 20:
        size -= 1
        title_font = ImageFont.truetype(str(FONT), size)
    draw.text((30, 31), heading, font=title_font, fill=WHITE, anchor="lm")
    draw.text((1890, 31), f"普通成员 · 虚构数据 · v{VERSION} / {SOURCE[:7]}",
              font=ImageFont.truetype(str(FONT), 20), fill=QUIET, anchor="rm")
    centers = [1020] if len(cue["captionLines"]) == 1 else [998, 1042]
    font = ImageFont.truetype(str(FONT), 33)
    for line, y in zip(cue["captionLines"], centers):
        draw.text((960, y), line, font=font, fill=WHITE, anchor="mm")
    return canvas


def render_cue(cue, capture, chapter, args, ffmpeg):
    folder = args.cache / "cues" / cue["id"]
    folder.mkdir(parents=True, exist_ok=True)
    clip = folder / "clip.mp4"
    signature_data = {"cue": cue, "capture": capture, "style": 1}
    shutdown_evidence = args.shutdown_evidence if cue["id"] == "40" else None
    if shutdown_evidence:
        signature_data.update({"style": 2, "shutdownEvidence": shutdown_evidence})
    signature = hashlib.sha256(json.dumps(signature_data,
                                         ensure_ascii=False, sort_keys=True).encode()).hexdigest()
    saved = folder / "signature.txt"
    if not args.redo and clip.is_file() and saved.is_file() and saved.read_text() == signature:
        log(f"Cue {cue['id']}: reuse unchanged inputs")
        return clip
    entries = []
    factor = min(1.0, cue["videoDuration"] / cue["captureDuration"])
    for index, frame in enumerate(capture["frames"]):
        at = 0 if index == 0 else max(0, (frame["time"] - capture["start"]) / 1000 * factor)
        at = min(at, cue["videoDuration"] - .001)
        target = folder / f"frame-{index:05}.jpg"
        compose(frame["filename"], cue, chapter, shutdown_evidence if at >= .9 else None).save(target, quality=94, subsampling=0)
        if entries and at <= entries[-1][1]:
            entries[-1] = (target, entries[-1][1])
        else:
            entries.append((target, at))
    concat = ["ffconcat version 1.0"]
    for index, (filename, at) in enumerate(entries):
        until = entries[index + 1][1] if index + 1 < len(entries) else cue["videoDuration"]
        concat.extend([f"file {quote(filename)}", f"duration {until - at:.9f}"])
    concat.append(f"file {quote(entries[-1][0])}")
    listing = folder / "frames.ffconcat"
    write_text(listing, "\n".join(concat) + "\n")
    run([ffmpeg, "-hide_banner", "-y", "-f", "concat", "-safe", "0", "-i", listing,
         "-vf", "scale=in_range=full:out_range=limited:out_color_matrix=bt709,format=yuv420p,fps=30,tpad=stop_mode=clone:stop_duration=10",
         "-frames:v", cue["frameCount"], "-an", "-c:v", "libx264", "-preset", "fast", "-crf", "19",
         "-pix_fmt", "yuv420p", "-color_range", "tv", "-colorspace", "bt709", "-color_primaries", "bt709",
         "-color_trc", "bt709", "-threads", "2", "-video_track_timescale", "90000", "-movflags", "+faststart", clip],
        folder / "encode.log")
    write_text(saved, signature)
    log(f"Cue {cue['id']}: {cue['videoDuration']:.3f}s from {len(entries)} real captured frames")
    return clip


def make_soundtrack(timeline, args, ffmpeg):
    if digest(args.music) != MUSIC_SHA:
        raise ValueError("Music differs from the approved Close Up source")
    count = timeline[-1]["frameEnd"] * (RATE // FPS)
    voice_path = args.cache / "narration.wav"
    with wave.open(str(voice_path), "wb") as target:
        target.setnchannels(1); target.setsampwidth(2); target.setframerate(RATE)
        for cue in timeline:
            target.writeframes(b"\0\0" * cue["leadSamples"])
            with wave.open(cue["audioPath"], "rb") as source:
                target.writeframes(source.readframes(source.getnframes()))
            target.writeframes(b"\0\0" * cue["paddingSamples"])
    with wave.open(str(voice_path), "rb") as source:
        voice = np.frombuffer(source.readframes(source.getnframes()), dtype="<i2").astype(np.float32) / 32768
    active = voice[np.abs(voice) > 10 ** (-42 / 20)]
    if not len(active):
        raise ValueError("Narration is silent")
    voice_gain = min(10 ** (-19 / 20) / float(np.sqrt(np.mean(active ** 2))),
                     10 ** (-2 / 20) / float(np.max(np.abs(voice))))
    voice *= voice_gain
    raw = run([ffmpeg, "-hide_banner", "-v", "error", "-i", args.music, "-ac", "2", "-ar", RATE,
               "-f", "f32le", "-"], binary=True).stdout
    source_music = np.frombuffer(raw, dtype="<f4").reshape(-1, 2)
    overlap = min(round(2.0 * RATE), len(source_music) // 4)
    if len(source_music) <= 2 * overlap:
        raise ValueError("Music is too short for a smooth loop")
    music = np.zeros((count, 2), dtype=np.float32)
    offset, loops = 0, []
    fade = np.linspace(0, 1, overlap, dtype=np.float32)[:, None]
    while offset < count:
        length = min(len(source_music), count - offset)
        if offset:
            cross = min(overlap, length)
            music[offset:offset + cross] = music[offset:offset + cross] * (1 - fade[:cross]) + source_music[:cross] * fade[:cross]
            music[offset + cross:offset + length] = source_music[cross:length]
            loops.append(offset / RATE)
        else:
            music[:length] = source_music[:length]
        if offset + length >= count:
            break
        offset += len(source_music) - overlap
    music_gain = 10 ** (-29 / 20) / max(1e-12, float(np.sqrt(np.mean(music ** 2))))
    music *= music_gain
    hop, gain = RATE // 50, 1.0
    envelope = np.ones(count, dtype=np.float32)
    for at in range(0, count, hop):
        until = min(count, at + hop)
        context = voice[max(0, at - hop):min(count, until + 3 * hop)]
        speaking = float(np.sqrt(np.mean(context ** 2))) > 10 ** (-39 / 20)
        target = 10 ** (-8 / 20) if speaking else 1.0
        step = 1 - math.exp(-.02 / (.035 if speaking else .32))
        following = gain + step * (target - gain)
        envelope[at:until] = np.linspace(gain, following, until - at, endpoint=False)
        gain = following
    envelope[:round(.8 * RATE)] *= np.linspace(0, 1, round(.8 * RATE), dtype=np.float32)
    envelope[-round(1.8 * RATE):] *= np.linspace(1, 0, round(1.8 * RATE), dtype=np.float32)
    music *= envelope[:, None]
    music += voice[:, None]
    limiter = min(1.0, 10 ** (-1.5 / 20) / max(1e-12, float(np.max(np.abs(music)))))
    music *= limiter
    soundtrack = args.cache / "soundtrack.wav"
    with wave.open(str(soundtrack), "wb") as target:
        target.setnchannels(2); target.setsampwidth(2); target.setframerate(RATE)
        target.writeframes(np.clip(np.round(music * 32767), -32768, 32767).astype("<i2").tobytes())
    db = lambda value: 20 * math.log10(max(1e-12, value))
    return soundtrack, {"voiceGainDb": db(voice_gain), "musicGainDb": db(music_gain),
                        "musicBaseRmsDbFS": -29, "duckDb": -8, "crossfadeSeconds": overlap / RATE,
                        "loopStarts": loops, "fadeInSeconds": .8, "fadeOutSeconds": 1.8,
                        "limiterGainDb": db(limiter), "mixedPeakDbFS": db(float(np.max(np.abs(music)))),
                        "clippedSamples": int(np.count_nonzero(np.abs(music) >= 1)),
                        "speechTimeStretching": False, "speechCuts": False,
                        "originalNarrationTimelineSha256": digest(voice_path), "soundtrackSha256": digest(soundtrack)}


def main():
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="backslashreplace")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=BASE / "narration.json")
    parser.add_argument("--audio-manifest", type=Path, default=BASE / "audio/audio-manifest.json")
    parser.add_argument("--audio-root", type=Path, default=BASE / "audio")
    parser.add_argument("--capture", type=Path, default=REPO / ".runtime/training-v1.9.1/capture/capture.json")
    parser.add_argument("--music", type=Path, default=REPO / ".runtime/training-v1.9.1/music/close-up.mp3")
    parser.add_argument("--cache", type=Path, default=REPO / ".runtime/training-v1.9.1/render")
    parser.add_argument("--out", type=Path, default=BASE / "delivery")
    parser.add_argument("--tools-root", type=Path, default=TOOLS)
    parser.add_argument("--jobs", type=int, default=3)
    parser.add_argument("--redo", action="store_true")
    parser.add_argument("--check-inputs", action="store_true")
    args = parser.parse_args()
    if not 1 <= args.jobs <= 4:
        parser.error("--jobs must be between 1 and 4")
    args.cache.mkdir(parents=True, exist_ok=True)
    args.out.mkdir(parents=True, exist_ok=True)
    ffmpeg, tool_provenance = check_tools(args.tools_root)
    narration, timeline, chapters, captures, frames_sha = load_inputs(args)
    args.shutdown_evidence = read_json(args.capture).get("shutdownEvidence")
    total = timeline[-1]["end"]
    log(f"Validated {len(timeline)} cues; intact speech plus holds: {total:.3f}s / {timeline[-1]['frameEnd']} frames")
    if args.check_inputs:
        write_json(args.cache / "input-check.json", {"passed": True, "duration": total, "cues": len(timeline),
                                                    "narrationSha256": digest(args.manifest), "tools": tool_provenance})
        return
    chapter_titles = {str(x["id"]): x["title"] for x in chapters}
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.jobs) as pool:
        clips = list(pool.map(lambda cue: render_cue(cue, captures[cue["id"]], chapter_titles[str(cue["chapter"])], args, ffmpeg), timeline))
    listing = args.cache / "clips.ffconcat"
    write_text(listing, "ffconcat version 1.0\n" + "\n".join(f"file {quote(clip)}" for clip in clips) + "\n")
    picture = args.cache / "picture.mp4"
    run([ffmpeg, "-hide_banner", "-y", "-f", "concat", "-safe", "0", "-i", listing,
         "-map", "0:v:0", "-c:v", "copy", "-an", "-movflags", "+faststart", picture], args.cache / "concat.log")
    soundtrack, mix = make_soundtrack(timeline, args, ffmpeg)
    metadata = [";FFMETADATA1", f"title=Vehicle Manager v{VERSION} - Member Training", f"comment=Fictional ordinary-member demonstration; source {SOURCE}"]
    for chapter in chapters:
        metadata.extend(["[CHAPTER]", "TIMEBASE=1/1000", f"START={round(chapter['start'] * 1000)}",
                         f"END={round(chapter['end'] * 1000)}", "title=" + chapter["title"].replace("=", "\\=")])
    metadata_path = args.cache / "chapters.ffmetadata"
    write_text(metadata_path, "\n".join(metadata) + "\n")
    video = args.out / "vehicle-manager-member-training-v1.9.1-zh-CN.mp4"
    run([ffmpeg, "-hide_banner", "-y", "-i", picture, "-i", soundtrack, "-i", metadata_path,
         "-map", "0:v:0", "-map", "1:a:0", "-map_metadata", "2", "-map_chapters", "2",
         "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-ar", RATE, "-ac", "2",
         "-t", f"{total:.9f}", "-movflags", "+faststart", video], args.cache / "mux.log")
    captions = [f"{i}\n{stamp(c['start'])} --> {stamp(c['end'])}\n" + "\n".join(c["captionLines"]) for i, c in enumerate(timeline, 1)]
    write_text(args.out / "vehicle-manager-member-training-v1.9.1-zh-CN.srt", "\n\n".join(captions) + "\n")
    write_json(args.out / "timeline.json", {"sourceCommit": SOURCE, "version": VERSION, "duration": total,
                                           "fps": FPS, "frames": timeline[-1]["frameEnd"], "chapters": chapters, "cues": timeline})
    rows = ["# Narration and actual chapter times", "", f"Application: {VERSION}. Source: `{SOURCE}`. All on-screen records are fictional.", ""]
    for chapter in chapters:
        rows.extend([f"## {stamp(chapter['start']).replace(',', '.')} — {chapter['title']}", ""])
        for cue in timeline:
            if str(cue["chapter"]) == str(chapter["id"]):
                rows.extend([f"{stamp(cue['start']).replace(',', '.')} / {cue['title']}", "", cue["text"], ""])
    write_text(args.out / "script-and-chapters.md", "\n".join(rows).rstrip() + "\n")
    preview_cue = timeline[min(4, len(timeline) - 1)]
    preview_frames = captures[preview_cue["id"]]["frames"]
    compose(preview_frames[len(preview_frames) // 2]["filename"], preview_cue,
            chapter_titles[str(preview_cue["chapter"])]).save(args.out / "preview.jpg", quality=95)
    provenance = {"sourceCommit": SOURCE, "version": VERSION, "duration": total, "frames": timeline[-1]["frameEnd"],
                  "narrationSha256": digest(args.manifest), "audioManifestSha256": digest(args.audio_manifest),
                  "captureManifestSha256": digest(args.capture), "captureFrameSequenceSha256": frames_sha,
                  "sourceMusicSha256": MUSIC_SHA, "music": "Close Up", "musicArtist": "Michael Ramir C.",
                  "tools": tool_provenance, "mix": mix, "videoSha256": digest(video),
                  "shutdownEvidenceOverlay": bool(args.shutdown_evidence),
                  "humanListeningPerformed": False, "humanVisualReviewPerformed": False,
                  "limitation": "Automated rendering does not establish natural pronunciation, member-only workflow correctness or complete human listening."}
    write_json(args.out / "production-provenance.json", provenance)
    log(json.dumps({"video": str(video), "duration": total, "frames": timeline[-1]["frameEnd"], "sha256": provenance["videoSha256"]}))


if __name__ == "__main__":
    main()
