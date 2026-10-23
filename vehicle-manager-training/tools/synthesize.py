"""Offline Mandarin Kokoro narration through sherpa-onnx's UTF-8 C API.

Python stdlib only. Avoids Windows ANSI command-line corruption without
changing the system locale. ABI structures come from the matching bundled
official v1.13.8 header, not a different installed Python package.
"""
from __future__ import annotations

import argparse
import ctypes as C
import json
import os
from pathlib import Path
import re
import sys
import time

TOOLS = Path(__file__).resolve().parent
SHERPA = TOOLS / "sherpa-onnx-v1.13.8-win-x64-shared-MT-Release"
MODEL = TOOLS / "kokoro-multi-lang-v1_0"
STRUCT_NAMES = [
    "SherpaOnnxOfflineTtsVitsModelConfig", "SherpaOnnxOfflineTtsMatchaModelConfig",
    "SherpaOnnxOfflineTtsKokoroModelConfig", "SherpaOnnxOfflineTtsKittenModelConfig",
    "SherpaOnnxOfflineTtsZipvoiceModelConfig", "SherpaOnnxOfflineTtsPocketModelConfig",
    "SherpaOnnxOfflineTtsSupertonicModelConfig", "SherpaOnnxOfflineTtsModelConfig",
    "SherpaOnnxOfflineTtsConfig", "SherpaOnnxGenerationConfig", "SherpaOnnxGeneratedAudio",
]


def abi_types():
    header = (SHERPA / "include/sherpa-onnx/c-api/c-api.h").read_text(encoding="utf-8")
    types = {"constchar*": C.c_char_p, "float": C.c_float, "int32_t": C.c_int32,
             "constfloat*": C.POINTER(C.c_float)}
    for name in STRUCT_NAMES:
        match = re.search(r"typedef struct " + name + r"\s*\{(.*?)\}\s*" + name + r";", header, re.S)
        if not match:
            raise RuntimeError(f"Matching sherpa header lacks {name}")
        body = re.sub(r"/\*.*?\*/", "", match[1], flags=re.S)
        fields = []
        for declaration in body.split(";"):
            if not declaration.strip():
                continue
            field = re.fullmatch(r"\s*(.+?)([A-Za-z_]\w*)\s*", declaration, flags=re.S)
            if not field:
                raise RuntimeError(f"Unsupported ABI field: {declaration}")
            kind, field_name = re.sub(r"\s+", "", field[1]), field[2]
            fields.append((field_name, types[kind]))
        types[name] = type(name, (C.Structure,), {"_fields_": fields})
    return types


def engine():
    types = abi_types()
    dll_directory = os.add_dll_directory(str(SHERPA / "lib"))
    dll = C.CDLL(str(SHERPA / "lib/sherpa-onnx-c-api.dll"))
    config_type = types["SherpaOnnxOfflineTtsConfig"]
    generation_type = types["SherpaOnnxGenerationConfig"]
    audio_type = types["SherpaOnnxGeneratedAudio"]
    dll.SherpaOnnxCreateOfflineTts.argtypes = [C.POINTER(config_type)]
    dll.SherpaOnnxCreateOfflineTts.restype = C.c_void_p
    dll.SherpaOnnxDestroyOfflineTts.argtypes = [C.c_void_p]
    dll.SherpaOnnxDestroyOfflineTts.restype = None
    dll.SherpaOnnxOfflineTtsGenerateWithConfig.argtypes = [C.c_void_p, C.c_char_p, C.POINTER(generation_type), C.c_void_p, C.c_void_p]
    dll.SherpaOnnxOfflineTtsGenerateWithConfig.restype = C.POINTER(audio_type)
    dll.SherpaOnnxDestroyOfflineTtsGeneratedAudio.argtypes = [C.POINTER(audio_type)]
    dll.SherpaOnnxDestroyOfflineTtsGeneratedAudio.restype = None
    dll.SherpaOnnxWriteWave.argtypes = [C.POINTER(C.c_float), C.c_int32, C.c_int32, C.c_char_p]
    dll.SherpaOnnxWriteWave.restype = C.c_int32
    config = config_type()
    config.model.num_threads = 2
    config.model.provider = b"cpu"
    kokoro = config.model.kokoro
    for field_name, filename in [("model", "model.onnx"), ("voices", "voices.bin"), ("tokens", "tokens.txt"), ("data_dir", "espeak-ng-data")]:
        setattr(kokoro, field_name, str(MODEL / filename).encode("utf-8"))
    kokoro.lexicon = ",".join(str(MODEL / x) for x in ["lexicon-us-en.txt", "lexicon-zh.txt"]).encode("utf-8")
    kokoro.length_scale = 1.0
    config.rule_fsts = ",".join(str(MODEL / x) for x in ["date-zh.fst", "number-zh.fst", "phone-zh.fst"]).encode("utf-8")
    config.max_num_sentences = 1
    config.silence_scale = 0.3
    handle = dll.SherpaOnnxCreateOfflineTts(C.byref(config))
    if not handle:
        raise RuntimeError("Cannot create Kokoro CPU engine")
    return dll, handle, generation_type, dll_directory


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser()
    parser.add_argument("--samples", action="store_true")
    parser.add_argument("--manifest", type=Path, help="UTF-8 JSON array or object with segments/cues; each entry has id and tts/text")
    parser.add_argument("--out", type=Path, default=TOOLS.parent / "production/audio")
    parser.add_argument("--sid", type=int, default=45)
    parser.add_argument("--speed", type=float, default=1.0)
    args = parser.parse_args()
    if args.samples:
        segments = [
            {"id": "voice-sample-01", "text": "欢迎使用车辆管理系统。今天，我们用三分钟，了解新车辆的登记、资料维护，以及诊断报告导入。"},
            {"id": "voice-sample-02", "text": "先核对车辆识别代号，也就是 VIN。打开 DOVE 导入，可一次选择多份报告。保存之前，请检查车辆匹配结果。"},
        ]
    elif args.manifest:
        content = json.loads(args.manifest.read_text(encoding="utf-8-sig"))
        segments = content if isinstance(content, list) else content.get("segments", content.get("cues"))
        if not isinstance(segments, list) or not segments:
            raise ValueError("Narration needs nonempty segments/cues")
    else:
        parser.error("Choose --samples or --manifest")
    if not 0 < args.speed < 2 or not 0 <= args.sid < 53:
        parser.error("Invalid voice or speed")
    args.out.mkdir(parents=True, exist_ok=True)
    dll, handle, generation_type, dll_directory = engine()
    results = []
    try:
        for segment in segments:
            identifier, text = str(segment["id"]), segment.get("tts", segment.get("text"))
            if not re.fullmatch(r"[A-Za-z0-9_-]+", identifier) or not isinstance(text, str) or not text.strip():
                raise ValueError("Each segment needs a safe unique id and nonblank text")
            if any(x["id"] == identifier for x in results):
                raise ValueError("Duplicate segment id")
            output = (args.out / (identifier + ".wav")).resolve()
            generation = generation_type()
            generation.sid, generation.speed, generation.silence_scale = args.sid, args.speed, 0.3
            started = time.monotonic()
            audio = dll.SherpaOnnxOfflineTtsGenerateWithConfig(handle, text.encode("utf-8"), C.byref(generation), None, None)
            if not audio:
                raise RuntimeError(f"Speech generation failed: {identifier}")
            try:
                n, rate = audio.contents.n, audio.contents.sample_rate
                if n / rate < min(1.0, len(text) / 10):
                    raise RuntimeError(f"Implausibly short speech; reject corrupted input: {identifier}")
                if not dll.SherpaOnnxWriteWave(audio.contents.samples, n, rate, str(output).encode("utf-8")):
                    raise RuntimeError(f"Cannot save speech: {identifier}")
                result = {"id": identifier, "text": text, "path": str(output), "duration": n / rate, "sampleRate": rate, "samples": n, "sid": args.sid, "voice": "zf_xiaobei" if args.sid == 45 else f"sid-{args.sid}", "speed": args.speed}
                results.append(result)
                print(json.dumps({"id": identifier, "duration": round(n / rate, 3), "secondsToGenerate": round(time.monotonic() - started, 3)}, ensure_ascii=False), flush=True)
            finally:
                dll.SherpaOnnxDestroyOfflineTtsGeneratedAudio(audio)
    finally:
        dll.SherpaOnnxDestroyOfflineTts(handle)
        dll_directory.close()
    manifest = args.out / ("voice-samples.json" if args.samples else "audio-manifest.json")
    manifest.write_text(json.dumps(results, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"manifest": str(manifest), "totalAudioSeconds": sum(x["duration"] for x in results)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
