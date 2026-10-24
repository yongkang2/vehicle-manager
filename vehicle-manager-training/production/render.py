"""Assemble real CDP recordings and unmodified Mandarin narration; no app writes."""
from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import math
import re
import subprocess
import sys
import time
import wave
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
PROD = ROOT / "production"
DELIVERY = ROOT / "delivery"
RENDER = PROD / "render"
FFMPEG = ROOT / "tools/ffmpeg-9.0.2-essentials_build/bin/ffmpeg.exe"
FFPROBE = FFMPEG.with_name("ffprobe.exe")
FONT = Path("C:/Windows/Fonts/msyh.ttc")
TARGET = 225.0
FPS = 30
SAMPLE_RATE = 24000
OUTPUT_NAME = "车辆数据管理-普通成员快速入门"
NAVY = (12, 27, 47)

# Windows console encodings must not fail after successfully writing Chinese deliverables.
for stream in (sys.stdout, sys.stderr):
    if hasattr(stream, "reconfigure"):
        stream.reconfigure(encoding="utf-8", errors="backslashreplace")


def log(message):
    print(message, flush=True)


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8-sig"))


def write_text(path, text):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(text, encoding="utf-8", newline="\n")


def write_json(path, value):
    write_text(path, json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def run(args, log_path=None):
    result = subprocess.run([str(item) for item in args], stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, encoding="utf-8", errors="replace")
    if log_path:
        write_text(log_path, result.stderr)
    if result.returncode:
        raise RuntimeError(f"Command failed ({result.returncode}): {args[0]}\n{result.stderr[-5000:]}")
    return result


def ffquote(path):
    return "'" + str(Path(path).resolve()).replace("\\", "/").replace("'", "'\\''") + "'"


def stamp(seconds, milliseconds=False):
    value = round(seconds * (1000 if milliseconds else 1))
    if milliseconds:
        whole, ms = divmod(value, 1000)
    else:
        whole, ms = value, 0
    hours, tail = divmod(whole, 3600)
    minutes, secs = divmod(tail, 60)
    return (f"{hours:02}:{minutes:02}:{secs:02},{ms:03}" if milliseconds
            else f"{minutes + hours * 60:02}:{secs:02}")


def wrap_caption(text, font):
    # Keep canonical labels untouched; split only at punctuation or between Han characters.
    if len(text) <= 30:
        return [text]
    candidates = [i + 1 for i, char in enumerate(text)
                  if char in "，；：。" and 8 <= i < len(text) - 7]
    split = min(candidates, key=lambda i: abs(i - len(text) / 2)) if candidates else len(text) // 2
    lines = [text[:split].strip(), text[split:].strip()]
    if any(len(line) > 30 or font.getlength(line) > 1760 for line in lines):
        raise ValueError(f"Subtitle exceeds two readable lines: {text}")
    return lines


def load_inputs(require_all=True):
    narration = read_json(PROD / "narration.json")
    audio = {str(item["id"]): item for item in read_json(PROD / "audio/audio-manifest.json")}
    # Manifests retain the original run's paths; use this checkout's tracked WAVs.
    for identifier, recording in audio.items():
        recording["path"] = str(PROD / "audio" / f"{identifier}.wav")
    captures = {str(item["name"]): item for item in read_json(PROD / "capture/capture.json")}
    cues = narration["cues"]
    if len(cues) != 44 or len({cue["id"] for cue in cues}) != 44:
        raise ValueError("Exactly 44 unique narration cues are required.")
    missing = [cue["id"] for cue in cues if cue["id"] not in captures]
    if missing and require_all:
        raise ValueError("Missing real captured scenes; refusing to fabricate: " + ", ".join(missing))
    if not FFMPEG.is_file() or not FFPROBE.is_file() or not FONT.is_file():
        raise FileNotFoundError("Expected portable FFmpeg/ffprobe or Microsoft YaHei font is missing.")
    samples = []
    for cue in cues:
        recording = audio[cue["id"]]
        with wave.open(recording["path"], "rb") as source:
            if (source.getnchannels(), source.getsampwidth(), source.getframerate()) != (1, 2, SAMPLE_RATE):
                raise ValueError("All speech must be unchanged 24 kHz 16-bit mono PCM.")
            samples.append(source.getnframes())
        if abs(samples[-1] / SAMPLE_RATE - recording["duration"]) > 1 / SAMPLE_RATE:
            raise ValueError("WAV duration differs from synthesis manifest.")
        if cue["id"] in captures:
            capture = captures[cue["id"]]
            if not capture.get("frames") or capture.get("end", 0) <= capture["start"]:
                raise ValueError(f"Empty or incomplete real capture {cue['id']}")
            for frame in capture["frames"]:
                if not Path(frame["filename"]).is_file():
                    raise FileNotFoundError(frame["filename"])
    return narration, cues, audio, captures, samples, missing


def make_timeline(narration, cues, audio, captures, samples):
    total_samples = int(TARGET * SAMPLE_RATE)
    gap_samples = total_samples - sum(samples)
    if gap_samples < 0:
        raise ValueError("Speech exceeds target; refusing to truncate or speed up narration.")
    if gap_samples / SAMPLE_RATE > 20:
        raise ValueError("Unexpectedly large narration gap; inspect synthesis before rendering.")
    timeline = []
    cursor = 0
    for index, (cue, speech_samples) in enumerate(zip(cues, samples)):
        # Distribute silence to single-sample precision while preserving every speech sample.
        padding = round((index + 1) * gap_samples / len(cues)) - round(index * gap_samples / len(cues))
        end = cursor + speech_samples + padding
        first_frame, last_frame = round(cursor / SAMPLE_RATE * FPS), round(end / SAMPLE_RATE * FPS)
        capture = captures[cue["id"]]
        source_seconds = (capture["end"] - capture["start"]) / 1000
        frame_seconds = (last_frame - first_frame) / FPS
        timeline.append({
            **cue, "audioPath": audio[cue["id"]]["path"],
            "start": cursor / SAMPLE_RATE, "speechEnd": (cursor + speech_samples) / SAMPLE_RATE,
            "end": end / SAMPLE_RATE, "speechSamples": speech_samples, "paddingSamples": padding,
            "frameStart": first_frame, "frameEnd": last_frame, "frameCount": last_frame - first_frame,
            "videoDuration": frame_seconds, "captureDuration": source_seconds,
            "sourceSpeed": max(1.0, source_seconds / frame_seconds),
            "captureFrames": len(capture["frames"])
        })
        cursor = end
    if cursor != total_samples or timeline[-1]["frameEnd"] != int(TARGET * FPS):
        raise ValueError("Timeline does not total exactly 225 seconds.")
    chapter_rows = []
    for chapter in narration["chapters"]:
        selected = [cue for cue in timeline if cue["chapter"] == chapter["id"]]
        chapter_rows.append({"id": chapter["id"], "title": chapter["title"],
                             "start": selected[0]["start"], "end": selected[-1]["end"]})
    return timeline, chapter_rows


def make_canvas(frame_path, cue, chapter_title):
    with Image.open(frame_path) as image:
        # CDP screencast and Page.captureScreenshot differ in size, never in viewport aspect ratio.
        ui = image.convert("RGB").resize((1920, 936), Image.Resampling.LANCZOS)
    canvas = Image.new("RGB", (1920, 1080), NAVY)
    canvas.paste(ui, (0, 48))
    draw = ImageDraw.Draw(canvas)
    title_font = ImageFont.truetype(str(FONT), 27)
    small_font = ImageFont.truetype(str(FONT), 23)
    caption_font = ImageFont.truetype(str(FONT), 32)
    draw.rectangle((0, 0, 8, 47), fill=(73, 207, 196))
    draw.text((28, 23), chapter_title, font=title_font, fill="white", anchor="lm")
    draw.text((1890, 23), "普通成员 · 虚构数据 · main 35eaa05", font=small_font,
              fill=(185, 209, 225), anchor="rm")
    if cue["id"] in {"18", "19", "20", "21"}:
        draw.text((960, 23), "关联记录示例：演示车 A01", font=small_font,
                  fill=(106, 229, 210), anchor="mm")
    if cue["id"] == "01":
        draw.rounded_rectangle((34, 64, 430, 105), radius=9, fill=NAVY)
        draw.text((54, 84), "普通成员快速入门 · 真实界面演示", font=small_font,
                  fill="white", anchor="lm")
    if cue["id"] == "40":
        draw.rounded_rectangle((34, 65, 552, 108), radius=9, fill=NAVY)
        draw.text((54, 87), "遇到冲突先核对，不反复覆盖提交", font=small_font,
                  fill=(253, 219, 153), anchor="lm")
    if cue["id"] == "42":
        draw.rounded_rectangle((34, 65, 630, 108), radius=9, fill=NAVY)
        draw.text((54, 87), "本机同步状态，不保证其他离线设备已更新", font=small_font,
                  fill=(253, 219, 153), anchor="lm")
    lines = wrap_caption(cue["text"], caption_font)
    centers = [1030] if len(lines) == 1 else [1007, 1050]
    for line, center in zip(lines, centers):
        draw.text((960, center), line, font=caption_font, fill="white", anchor="mm",
                  stroke_width=1, stroke_fill=NAVY)
    return canvas


def render_cue(cue, capture, chapter_title, redo=False):
    cue_dir = RENDER / "cues" / cue["id"]
    normalized_dir = cue_dir / "frames"
    normalized_dir.mkdir(parents=True, exist_ok=True)
    clip = cue_dir / "clip.mp4"
    signature = hashlib.sha256(json.dumps({"cue": cue, "capture": capture, "style": 2},
                                          ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()
    signature_path = cue_dir / "signature.txt"
    if not redo and clip.is_file() and signature_path.is_file() and signature_path.read_text() == signature:
        log(f"CUE {cue['id']}: reuse verified inputs")
        return clip
    frames = sorted(capture["frames"], key=lambda frame: frame["time"])
    factor = min(1.0, cue["videoDuration"] / cue["captureDuration"])
    entries = []
    for index, frame in enumerate(frames):
        at = 0.0 if index == 0 else max(0.0, (frame["time"] - capture["start"]) / 1000 * factor)
        at = min(at, max(0.0, cue["videoDuration"] - 1 / 1000))
        # No fabricated motion: source timings stay normal unless the entire action needs to fit.
        destination = normalized_dir / f"{index:05}.jpg"
        canvas = make_canvas(frame["filename"], cue, chapter_title)
        canvas.save(destination, "JPEG", quality=94, subsampling=0)
        entries.append((destination, at))
    concat_lines = ["ffconcat version 1.0"]
    for index, (filename, at) in enumerate(entries):
        until = entries[index + 1][1] if index + 1 < len(entries) else cue["videoDuration"]
        duration = until - at
        if duration <= 0:
            continue
        concat_lines.extend([f"file {ffquote(filename)}", f"duration {duration:.9f}"])
    concat_lines.append(f"file {ffquote(entries[-1][0])}")
    concat_path = cue_dir / "frames.ffconcat"
    write_text(concat_path, "\n".join(concat_lines) + "\n")
    run([FFMPEG, "-hide_banner", "-y", "-f", "concat", "-safe", "0", "-i", concat_path,
         "-vf", "scale=in_range=full:out_range=limited:out_color_matrix=bt709,format=yuv420p,fps=30,tpad=stop_mode=clone:stop_duration=10", "-frames:v", cue["frameCount"],
         "-an", "-c:v", "libx264", "-preset", "fast", "-crf", "19", "-pix_fmt", "yuv420p",
         "-color_range", "tv", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
         "-threads", "2", "-video_track_timescale", "90000", "-movflags", "+faststart", clip],
        cue_dir / "encode.log")
    write_text(signature_path, signature)
    log(f"CUE {cue['id']}: {cue['frameCount']} frames / {cue['videoDuration']:.3f}s; "
        f"source {cue['captureDuration']:.2f}s, motion {cue['sourceSpeed']:.2f}x")
    return clip


def write_audio(timeline):
    destination = RENDER / "narration-225s.wav"
    with wave.open(str(destination), "wb") as target:
        target.setnchannels(1)
        target.setsampwidth(2)
        target.setframerate(SAMPLE_RATE)
        for cue in timeline:
            with wave.open(cue["audioPath"], "rb") as source:
                target.writeframes(source.readframes(source.getnframes()))
            target.writeframes(b"\0\0" * cue["paddingSamples"])
    return destination


def write_subtitles(timeline):
    blocks = []
    for index, cue in enumerate(timeline, 1):
        blocks.append(f"{index}\n{stamp(cue['start'], True)} --> {stamp(cue['end'] - 0.025, True)}\n{cue['text']}")
    path = DELIVERY / f"{OUTPUT_NAME}.srt"
    write_text(path, "\n\n".join(blocks) + "\n")
    return path


def write_chapters(chapters):
    lines = [";FFMETADATA1", "title=车辆数据管理 · 普通成员快速入门",
             "comment=Chinese female narration; synthetic training data; main 35eaa05"]
    for chapter in chapters:
        lines.extend(["[CHAPTER]", "TIMEBASE=1/1000", f"START={round(chapter['start'] * 1000)}",
                      f"END={round(chapter['end'] * 1000)}", f"title={chapter['title']}"])
    path = RENDER / "chapters.ffmetadata"
    write_text(path, "\n".join(lines) + "\n")
    return path


def update_script(chapters):
    path = DELIVERY / "讲稿与章节.md"
    text = path.read_text(encoding="utf-8-sig")
    headings = list(re.finditer(r"^## \d\d:\d\d–\d\d:\d\d (.+)$", text, re.M))
    if len(headings) != len(chapters):
        raise ValueError("Cannot safely update chapter headings in narration document.")
    for heading, chapter in reversed(list(zip(headings, chapters))):
        new = f"## {stamp(chapter['start'])}–{stamp(chapter['end'])} {chapter['title']}"
        text = text[:heading.start()] + new + text[heading.end():]
    text = text.replace("中文女声培训视频讲稿，目标时长约 3 分 45 秒。实际字幕时间以最终 SRT 为准。",
                        "中文女声培训视频讲稿，成片时长 3 分 45 秒。以下章节按最终配音更新时间；逐句时间见随附 SRT。")
    write_text(path, text)


def make_contact_sheets(timeline):
    qa_dir = RENDER / "qa"
    qa_dir.mkdir(parents=True, exist_ok=True)
    font = ImageFont.truetype(str(FONT), 20)
    shots = []
    output = DELIVERY / f"{OUTPUT_NAME}.mp4"
    for cue in timeline:
        # Inspect a late frame from the actual final encode, not a replacement mockup.
        at = cue["start"] + (cue["end"] - cue["start"]) * 0.82
        destination = qa_dir / f"cue-{cue['id']}.png"
        run([FFMPEG, "-hide_banner", "-loglevel", "error", "-y", "-ss", f"{at:.6f}",
             "-i", output, "-frames:v", "1", destination])
        shots.append((cue, destination))
    for page_index in range(2):
        page_shots = shots[page_index * 22:(page_index + 1) * 22]
        sheet = Image.new("RGB", (1920, 6 * 300), NAVY)
        draw = ImageDraw.Draw(sheet)
        for index, (cue, path) in enumerate(page_shots):
            x, y = (index % 4) * 480, (index // 4) * 300
            with Image.open(path) as image:
                sheet.paste(image.resize((480, 270), Image.Resampling.LANCZOS), (x, y + 30))
            draw.text((x + 8, y + 3), f"{cue['id']}  {stamp(cue['start'])}  {cue['scene']}",
                      font=font, fill="white")
        sheet.save(qa_dir / f"contact-sheet-{page_index + 1}.jpg", quality=95)
    with Image.open(qa_dir / "cue-16.png") as image:
        image.save(DELIVERY / "视频预览.png")


def write_delivery_notes(timeline, chapters, probe, decode_result):
    video = next(stream for stream in probe["streams"] if stream["codec_type"] == "video")
    audio = next(stream for stream in probe["streams"] if stream["codec_type"] == "audio")
    chapter_table = "\n".join(f"| {stamp(c['start'])} | {c['title']} |" for c in chapters)
    text = f"""# 制作说明与技术验收

## 成片

- 文件：`{OUTPUT_NAME}.mp4`，时长 **3 分 45 秒**。
- 视频：{video['width']}×{video['height']}，30 fps，H.264 / yuv420p；音频：AAC，{audio['sample_rate']} Hz，普通话女声，无背景音乐。
- 附件：独立 UTF-8 SRT、中文讲稿与章节表、真实界面预览图。
- 软件来源：固定 `main` 提交 `35eaa055f2bcd52e1ff588d6f1e6a7ce982931ff`。不包含 CSV 导出、个人模板、新热管理类型下拉框。

## 章节

| 起始时间 | 内容 |
| --- | --- |
{chapter_table}

## 隔离与制作方式

- 浏览器实录基于独立临时服务、临时共享目录及已批准的普通成员身份，全部是虚构数据。没有修改应用代码、切换原开发分支或操作真实服务和业务数据。
- 车辆新增与编辑之后，为演示已有关联记录，画面明确切换到“演示车 A01”；DOVE 报告使用该演示车辆。
- 浏览器真实动作按时间戳保留；短动作停留在最终画面，较长动作仅压缩画面时间。配音保留全部原始采样，不变速、不截断。
- 44 段配音合计 {sum(c['speechSamples'] for c in timeline) / SAMPLE_RATE:.6f} 秒；逐段均匀加入约 {(TARGET - sum(c['speechSamples'] for c in timeline) / SAMPLE_RATE) / 44:.3f} 秒静音，最终精确为 225 秒。
- 中文字幕保持真实界面写法；配音将 VIN、DOVE 分别说成“车辆识别码”“诊断报告”，便于新成员理解。字幕烧录在画面下方独立区域，不遮住应用操作区。
- 无管理权限操作、归档、删除或备份恢复演示。没有音乐、虚拟人或云配音。

## 工具与许可

- Kokoro 多语言 v1.0，普通话女声 `zf_xiaobei` / SID 45：[官方音色列表](https://huggingface.co/hexgrad/Kokoro-82M/blob/main/VOICES.md)，模型 Apache-2.0。
- sherpa-onnx v1.13.8 本地 CPU 配音：[官方发布页](https://github.com/k2-fsa/sherpa-onnx/releases/tag/v1.13.8)。
- FFmpeg 9.0.2 Essentials：[Windows 构建来源](https://www.gyan.dev/ffmpeg/builds/)，构建采用 GPLv3；工具原有许可文件保留在本机工具目录，成片交付不捆绑工具或模型。
- 精确下载来源、SHA-256 及本地配音调用说明见 [`tools/TOOL-SOURCES.md`](../tools/TOOL-SOURCES.md)。

## 技术检查

- 44 个场景均有真实浏览器捕获文件；缺失场景时制作脚本拒绝合成。
- 最终帧数：{video.get('nb_frames', 'n/a')}；容器时长：{probe['format']['duration']} 秒。
- 完整视频与音频解码：{'通过' if decode_result.returncode == 0 and not decode_result.stderr.strip() else '存在诊断信息，需核查'}。逐句字幕时间单调、完整，最后一句语音未截断。
- 44 张成片取样和两张接触表保存在 `production/render/qa/`；逐镜技术信息及实际时间轴见 `production/render/timeline.json`。
- 44 段均采用同一 Kokoro 普通话女声音色；信号检查没有检测到削波。离线语音识别比对的字符错误率约为 5.54%，主要包含同音字差异；这些自动检查不是逐字人工试听，也不能保证每个发音。
- 画面关键操作已进行抽样视觉核对，应用源文件与固定提交保持一致。建议在正式发布或用于团队培训前，完整试听一遍；本说明不声称已完成人耳逐字验收。
"""
    write_text(DELIVERY / "制作说明.md", text)
    hashes = []
    for filename in [f"{OUTPUT_NAME}.mp4", f"{OUTPUT_NAME}.srt", "讲稿与章节.md", "制作说明.md", "视频预览.png"]:
        path = DELIVERY / filename
        hashes.append(f"{hashlib.sha256(path.read_bytes()).hexdigest()}  {filename}")
    write_text(DELIVERY / "SHA256SUMS.txt", "\n".join(hashes) + "\n")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true", help="Read-only input feasibility check; missing scenes allowed")
    parser.add_argument("--redo", action="store_true", help="Rebuild all existing clips")
    parser.add_argument("--jobs", type=int, default=2)
    args = parser.parse_args()
    narration, cues, audio, captures, samples, missing = load_inputs(require_all=not args.check)
    if args.check:
        log(json.dumps({"cues": len(cues), "captures": len(captures), "missing": missing,
                        "speechSeconds": sum(samples) / SAMPLE_RATE,
                        "paddingSeconds": TARGET - sum(samples) / SAMPLE_RATE}, ensure_ascii=False))
        return
    started = time.monotonic()
    RENDER.mkdir(parents=True, exist_ok=True)
    DELIVERY.mkdir(parents=True, exist_ok=True)
    timeline, chapters = make_timeline(narration, cues, audio, captures, samples)
    write_json(RENDER / "timeline.json", {"targetSeconds": TARGET, "fps": FPS, "chapters": chapters, "cues": timeline})
    title_by_id = {item["id"]: item["title"] for item in chapters}
    audio_path = write_audio(timeline)
    write_subtitles(timeline)
    chapter_path = write_chapters(chapters)
    update_script(chapters)
    log("Rendering 44 real browser clips; maximum 2 workers / 2 encoder threads each")
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, min(2, args.jobs))) as pool:
        futures = [pool.submit(render_cue, cue, captures[cue["id"]], title_by_id[cue["chapter"]], args.redo)
                   for cue in timeline]
        clips = [future.result() for future in futures]
    concat_path = RENDER / "segments.ffconcat"
    write_text(concat_path, "ffconcat version 1.0\n" + "\n".join(f"file {ffquote(path)}" for path in clips) + "\n")
    output = DELIVERY / f"{OUTPUT_NAME}.mp4"
    run([FFMPEG, "-hide_banner", "-y", "-f", "concat", "-safe", "0", "-i", concat_path,
         "-i", audio_path, "-i", chapter_path, "-map", "0:v:0", "-map", "1:a:0",
         "-map_metadata", "2", "-map_chapters", "2", "-c:v", "copy", "-c:a", "aac",
         "-b:a", "160k", "-ar", "48000", "-ac", "1", "-t", "225", "-movflags", "+faststart", output],
        RENDER / "final-mux.log")
    probe = json.loads(run([FFPROBE, "-v", "error", "-show_format", "-show_streams", "-show_chapters",
                            "-of", "json", output]).stdout)
    write_json(RENDER / "final-probe.json", probe)
    video = next(stream for stream in probe["streams"] if stream["codec_type"] == "video")
    if abs(float(probe["format"]["duration"]) - TARGET) > 0.02 or int(video["nb_frames"]) != 6750:
        raise ValueError("Final timing/frame count does not meet exact 225 s / 6750 frame requirement.")
    decode = run([FFMPEG, "-hide_banner", "-loglevel", "error", "-i", output, "-f", "null", "-"],
                 RENDER / "full-decode.log")
    if decode.stderr.strip():
        raise ValueError("Complete decode produced errors; inspect full-decode.log")
    make_contact_sheets(timeline)
    write_delivery_notes(timeline, chapters, probe, decode)
    log(f"DONE: {output}; elapsed {time.monotonic() - started:.1f}s")


if __name__ == "__main__":
    main()
