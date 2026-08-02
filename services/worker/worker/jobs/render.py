"""render_preview / render_final handlers — §6.6."""

from __future__ import annotations

import json
import tempfile
from pathlib import Path
from typing import Any

from sqlalchemy import text

from worker.jobs import register
from worker.lib import s3
from worker.lib.ass import build_ass
from worker.lib.db import get_engine, update_progress
from worker.lib.render import build_plan, run_render, verify_output
from worker.lib.settings import get_settings

WATERMARK_LOCAL = Path("/tmp/reelforge-watermark-v2.png")


def _load_json(value: Any) -> Any:
    return json.loads(value) if isinstance(value, str) else value


def ensure_watermark() -> Path:
    """Wordmark PNG (assets/watermark.png equivalent, generated): white text on a
    translucent dark plate so it stays legible on any content."""
    if WATERMARK_LOCAL.exists():
        return WATERMARK_LOCAL
    from PIL import Image, ImageDraw, ImageFont

    img = Image.new("RGBA", (480, 120), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    draw.rounded_rectangle((0, 8, 478, 112), radius=28, fill=(10, 10, 16, 150))
    try:
        font = ImageFont.truetype(
            "/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf", 64
        )
    except OSError:
        font = ImageFont.load_default()
    draw.text((28, 22), "ReelForge", font=font, fill=(255, 255, 255, 230))
    img.save(WATERMARK_LOCAL)
    return WATERMARK_LOCAL


def _collect_sources(spec: dict, preview: bool, tmp: Path) -> dict[str, dict]:
    video_track = next(t for t in spec["tracks"] if t["type"] == "video")
    sources: dict[str, dict] = {}
    with get_engine().begin() as conn:
        for clip in video_track["clips"]:
            asset_id = clip["assetId"]
            if asset_id in sources:
                continue
            row = conn.execute(
                text(
                    "SELECT a.*, an.transcript FROM media_assets a "
                    "LEFT JOIN media_analysis an ON an.asset_id=a.id WHERE a.id=:id"
                ),
                {"id": asset_id},
            ).mappings().first()
            if row is None:
                raise RuntimeError(f"asset {asset_id} missing")
            key = row["storage_key"]
            if preview and clip["kind"] == "video" and row["proxy_key"]:
                key = row["proxy_key"]
            local = s3.download_to_tmp(key)
            sources[asset_id] = {
                "path": str(local),
                "duration": row["duration_sec"],
                "transcript": _load_json(row.get("transcript")),
            }
    return sources


def _speech_meta(spec: dict, sources: dict[str, dict]) -> dict:
    """Ducking windows + speech-bearing clip audio for the mixer (§6.6.6).

    Windows in timeline seconds; sourced from enabled caption words and from
    per-clip transcripts (word times mapped src→timeline through the trim).
    """
    from worker.lib.ducking import speech_windows

    words_timeline: list[dict] = []
    captions = spec.get("captions") or {}
    if captions.get("enabled"):
        words_timeline.extend(captions.get("words") or [])

    speech_clips: list[dict] = []
    video_track = next(t for t in spec["tracks"] if t["type"] == "video")
    for clip in video_track["clips"]:
        if clip["kind"] != "video":
            continue
        src = sources.get(clip["assetId"]) or {}
        transcript = src.get("transcript") or {}
        words = transcript.get("words") or []
        if not words:
            continue
        src_in = float(clip.get("srcIn") or 0.0)
        src_out = float(clip.get("srcOut") or 0.0)
        speed = float(clip.get("speed", 1.0)) or 1.0
        start = float(clip["timelineStart"])
        in_window = [w for w in words if w["e"] > src_in and w["s"] < src_out]
        if not in_window:
            continue
        speech_clips.append(
            {
                "path": src["path"],
                "srcIn": src_in,
                "srcOut": src_out,
                "speed": speed,
                "timelineStart": start,
            }
        )
        words_timeline.extend(
            {
                "w": w["w"],
                "s": start + max(0.0, (w["s"] - src_in)) / speed,
                "e": start + max(0.0, (w["e"] - src_in)) / speed,
            }
            for w in in_window
        )

    return {"windows": speech_windows(words_timeline), "clips": speech_clips}


def _collect_music(spec: dict) -> dict | None:
    audio_track = next((t for t in spec["tracks"] if t["type"] == "audio"), None)
    if not audio_track or not audio_track["clips"]:
        return None
    clip = audio_track["clips"][0]
    with get_engine().begin() as conn:
        row = conn.execute(
            text("SELECT storage_key FROM music_tracks WHERE id=:id"), {"id": clip["assetId"]}
        ).mappings().first()
        if row is None:
            row = conn.execute(
                text("SELECT storage_key FROM media_assets WHERE id=:id"),
                {"id": clip["assetId"]},
            ).mappings().first()
    if row is None:
        return None
    local = s3.download_to_tmp(row["storage_key"])
    return {
        "path": str(local),
        "srcIn": float(clip.get("srcIn", 0.0)),
        "gainDb": float(clip.get("gainDb", 0.0)),
        "duckUnderSpeechDb": float(clip.get("duckUnderSpeechDb", -10.0)),
    }


def _render(job: dict, final: bool) -> dict:
    payload = job["payload"]
    project_id = payload["projectId"]
    export_id = payload.get("exportId")
    settings = get_settings()

    with get_engine().begin() as conn:
        project = conn.execute(
            text("SELECT * FROM projects WHERE id=:id"), {"id": project_id}
        ).mappings().first()
        if project is None:
            raise RuntimeError(f"project {project_id} not found")
        export = None
        if export_id:
            export = conn.execute(
                text("SELECT * FROM exports WHERE id=:id"), {"id": export_id}
            ).mappings().first()

    spec = _load_json(project["edit_spec"])
    if export is not None:
        spec = {**spec, "watermark": {"enabled": bool(export["watermark"])}}
    resolution = export["resolution"] if export is not None else None

    with tempfile.TemporaryDirectory() as tmpdir:
        tmp = Path(tmpdir)
        sources = _collect_sources(spec, preview=not final, tmp=tmp)
        music = _collect_music(spec)

        text_track = next((t for t in spec["tracks"] if t["type"] == "text"), None)
        text_clips = text_track["clips"] if text_track else []
        ass_path = None
        if text_clips or (spec.get("captions", {}).get("enabled")):
            ass_path = tmp / "burn.ass"
            # scale-aware: build at output res via PlayRes
            preview_flag = not final
            if preview_flag:
                scale = 540 / min(spec["width"], spec["height"])
            elif resolution == "720p":
                scale = 720 / min(spec["width"], spec["height"])
            else:
                scale = 1080 / min(spec["width"], spec["height"])
            w = int(spec["width"] * min(scale, 1.0) // 2 * 2)
            h = int(spec["height"] * min(scale, 1.0) // 2 * 2)
            ass_path.write_text(build_ass(w, h, text_clips, spec.get("captions")),
                                encoding="utf-8")

        plan = build_plan(
            {**spec, "_speech": _speech_meta(spec, sources)},
            sources,
            preview=not final,
            ass_path=ass_path,
            watermark_png=ensure_watermark() if spec.get("watermark", {}).get("enabled") else None,
            music=music,
            resolution=resolution,
        )
        out = tmp / "out.mp4"
        run_render(plan, out, preview=not final,
                   on_progress=lambda p: update_progress(job["id"], p))
        snapshot = verify_output(out, plan)

        suffix = "final" if final else "preview"
        key = (f"{settings.bucket_renders}/{project['owner_id']}/"
               f"{project_id}/{suffix}-{job['id']}.mp4")
        s3.upload_file(out, key, "video/mp4")

    with get_engine().begin() as conn:
        if export_id:
            conn.execute(
                text(
                    "UPDATE exports SET status='done', storage_key=:k, "
                    "ffprobe=CAST(:probe AS jsonb) WHERE id=:id"
                ),
                {"k": key, "probe": json.dumps(snapshot), "id": export_id},
            )
        conn.execute(
            text("UPDATE projects SET status='ready', updated_at=now() WHERE id=:id"),
            {"id": project_id},
        )
    # cleanup downloaded sources
    for src in sources.values():
        Path(src["path"]).unlink(missing_ok=True)
    if music:
        Path(music["path"]).unlink(missing_ok=True)

    return {"storageKey": key, "ffprobe": snapshot, "progress": 100}


@register("render_preview")
def handle_preview(job: dict) -> dict:
    return _render(job, final=False)


@register("render_final")
def handle_final(job: dict) -> dict:
    try:
        return _render(job, final=True)
    except Exception:
        payload = job["payload"]
        if payload.get("exportId"):
            with get_engine().begin() as conn:
                conn.execute(
                    text("UPDATE exports SET status='failed' WHERE id=:id"),
                    {"id": payload["exportId"]},
                )
        raise
