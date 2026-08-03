"""FFmpeg/ffprobe helpers (P1: probe/thumbs/proxy; the render engine arrives in P2)."""

from __future__ import annotations

import json
import subprocess
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


class FfmpegError(RuntimeError):
    pass


def _run(cmd: list[str], timeout: int = 600) -> subprocess.CompletedProcess:
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    if proc.returncode != 0:
        raise FfmpegError(f"{cmd[0]} failed ({proc.returncode}): {proc.stderr[-800:]}")
    return proc


def ffprobe(path: Path | str) -> dict[str, Any]:
    proc = _run(
        [
            "ffprobe",
            "-v", "error",
            "-print_format", "json",
            "-show_format",
            "-show_streams",
            str(path),
        ]
    )
    return json.loads(proc.stdout)


def probe_summary(path: Path | str) -> dict[str, Any]:
    """Extract dims/duration/fps/codec/creation_time from ffprobe output."""
    data = ffprobe(path)
    fmt = data.get("format", {})
    out: dict[str, Any] = {
        "durationSec": float(fmt.get("duration", 0) or 0) or None,
        "creationTime": None,
        "width": None,
        "height": None,
        "fps": None,
        "hasAudio": False,
        "hasVideo": False,
    }
    import contextlib

    tags = {k.lower(): v for k, v in (fmt.get("tags") or {}).items()}
    if ct := tags.get("creation_time"):
        with contextlib.suppress(ValueError):
            parsed = datetime.fromisoformat(ct.replace("Z", "+00:00"))
            # normalize to NAIVE UTC: EXIF taken_at is naive, and mixing aware
            # and naive datetimes breaks event clustering (DECISIONS.md #12)
            if parsed.tzinfo is not None:
                parsed = parsed.astimezone(UTC).replace(tzinfo=None)
            out["creationTime"] = parsed
    for stream in data.get("streams", []):
        if stream.get("codec_type") == "video" and not out["hasVideo"]:
            out["hasVideo"] = True
            out["width"] = stream.get("width")
            out["height"] = stream.get("height")
            rate = stream.get("avg_frame_rate") or "0/1"
            try:
                num, den = rate.split("/")
                out["fps"] = round(int(num) / int(den), 3) if int(den) else None
            except (ValueError, ZeroDivisionError):
                out["fps"] = None
        elif stream.get("codec_type") == "audio":
            out["hasAudio"] = True
    return out


def extract_frame(video: Path | str, at_sec: float, out_jpg: Path | str, width: int = 512) -> Path:
    _run(
        [
            "ffmpeg", "-y", "-v", "error",
            "-ss", f"{max(0.0, at_sec):.3f}",
            "-i", str(video),
            "-frames:v", "1",
            "-vf", f"scale={width}:-2",
            "-q:v", "3",
            str(out_jpg),
        ]
    )
    return Path(out_jpg)


def make_proxy(video: Path | str, out_mp4: Path | str) -> Path:
    """540p H.264 editor proxy (SPEC §6.1.2)."""
    _run(
        [
            "ffmpeg", "-y", "-v", "error",
            "-i", str(video),
            "-vf", "scale=-2:540",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "28",
            "-c:a", "aac", "-b:a", "96k",
            "-movflags", "+faststart",
            str(out_mp4),
        ],
        timeout=1800,
    )
    return Path(out_mp4)


def extract_wav(media: Path | str, out_wav: Path | str, sr: int = 22050) -> Path | None:
    """Mono wav for librosa; returns None when the file has no audio stream."""
    try:
        _run(
            [
                "ffmpeg", "-y", "-v", "error",
                "-i", str(media),
                "-vn", "-ac", "1", "-ar", str(sr),
                str(out_wav),
            ]
        )
    except FfmpegError:
        return None
    return Path(out_wav)
