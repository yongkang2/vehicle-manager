"""Prepare the pinned edge-tts requests for a native Windows WebSocket client.

Only standard edge-tts request construction is reused; certificate validation
remains owned by Windows. Request files belong in ignored production scratch.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys
from xml.sax.saxutils import escape


def main(args):
    sys.path.insert(0, str(args.packages.resolve()))
    from edge_tts.communicate import connect_id, date_to_string, mkssml, remove_incompatible_characters, ssml_headers_plus_data
    from edge_tts.constants import SEC_MS_GEC_VERSION, WSS_HEADERS, WSS_URL
    from edge_tts.data_classes import TTSConfig
    from edge_tts.drm import DRM
    manifest = json.loads(args.manifest.read_text(encoding="utf-8-sig"))
    if manifest["voice"] != "zh-CN-XiaoyiNeural":
        raise ValueError("Approved voice mismatch")
    selected = set(args.segments.split(",")) if args.segments else None
    config = TTSConfig(manifest["voice"], "+0%", "+0%", "+0Hz", "SentenceBoundary")
    rows = []
    for cue in manifest["cues"]:
        if selected is not None and cue["id"] not in selected:
            continue
        text = cue.get("tts", cue["text"])
        command = (f"X-Timestamp:{date_to_string()}\r\n"
                   "Content-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n"
                   '{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"true","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}\r\n')
        rows.append({"id": cue["id"], "text": text,
                     "url": f"{WSS_URL}&ConnectionId={connect_id()}&Sec-MS-GEC={DRM.generate_sec_ms_gec()}&Sec-MS-GEC-Version={SEC_MS_GEC_VERSION}",
                     "headers": DRM.headers_with_muid(WSS_HEADERS),
                     "messages": [command, ssml_headers_plus_data(connect_id(), date_to_string(), mkssml(config, escape(remove_incompatible_characters(text))))]})
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(rows, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    print(json.dumps({"requests": len(rows), "voice": manifest["voice"]}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--packages", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--segments")
    main(parser.parse_args())
