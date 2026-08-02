"""generate_ai handler — SPEC §8. Provider call + asset creation + atomic refund."""

from __future__ import annotations

import json
import mimetypes
from pathlib import Path
from typing import Any

from sqlalchemy import text

from worker.jobs import register
from worker.lib import s3
from worker.lib.credits import refund_generation
from worker.lib.db import enqueue_job, get_engine
from worker.lib.gen_provider import get_provider
from worker.lib.safety import BlockedPromptError, check_prompt
from worker.lib.settings import get_settings

MAX_ATTEMPTS = 3


def _load_json(value: Any) -> Any:
    return json.loads(value) if isinstance(value, str) else value


def _kind_of_file(path: Path) -> str:
    mime = mimetypes.guess_type(str(path))[0] or ""
    if mime.startswith("video/"):
        return "video"
    if mime.startswith("audio/"):
        return "audio"
    return "image"


def _create_asset(conn, owner_id: str, path: Path, generation_id: str, index: int) -> str:
    settings = get_settings()
    ext = path.suffix.lstrip(".") or "bin"
    row = conn.execute(
        text(
            "INSERT INTO media_assets (id, owner_id, kind, status, storage_key, filename, "
            "bytes, synthetic, created_at) VALUES "
            "(substr(md5(random()::text || clock_timestamp()::text), 1, 25), "
            ":owner, :kind, 'analyzing', 'pending', :filename, :bytes, TRUE, now()) "
            "RETURNING id"
        ),
        {
            "owner": owner_id,
            "kind": _kind_of_file(path),
            "filename": f"ai-{generation_id[-8:]}-{index}.{ext}",
            "bytes": path.stat().st_size,
        },
    ).first()
    assert row is not None
    asset_id = row[0]
    storage_key = f"{settings.bucket_generated}/{owner_id}/{asset_id}.{ext}"
    s3.upload_file(path, storage_key)
    conn.execute(
        text("UPDATE media_assets SET storage_key=:k WHERE id=:id"),
        {"k": storage_key, "id": asset_id},
    )
    return asset_id


def _create_music_track(conn, owner_id: str, path: Path, prompt: str, params: dict) -> str:
    settings = get_settings()
    from worker.lib.ffmpeg import probe_summary

    duration = probe_summary(path)["durationSec"] or float(params.get("durationSec", 30))
    row = conn.execute(
        text(
            "INSERT INTO music_tracks (id, title, storage_key, duration_sec, license, "
            "attribution, owner_id, vibe_tags) VALUES "
            "(substr(md5(random()::text || clock_timestamp()::text), 1, 25), "
            ":title, 'pending', :dur, 'generated', NULL, :owner, NULL) RETURNING id"
        ),
        {"title": f"AI: {prompt[:60]}", "dur": duration, "owner": owner_id},
    ).first()
    assert row is not None
    track_id = row[0]
    storage_key = f"{settings.bucket_generated}/{owner_id}/music-{track_id}{path.suffix}"
    s3.upload_file(path, storage_key)
    conn.execute(
        text("UPDATE music_tracks SET storage_key=:k WHERE id=:id"),
        {"k": storage_key, "id": track_id},
    )
    return track_id


@register("generate_ai")
def handle(job: dict) -> dict:
    generation_id = job["payload"]["generationId"]
    with get_engine().begin() as conn:
        gen = conn.execute(
            text("SELECT * FROM generations WHERE id=:id"), {"id": generation_id}
        ).mappings().first()
    if gen is None:
        raise RuntimeError(f"generation {generation_id} not found")
    if gen["status"] in ("done", "refunded"):
        return {"generationId": generation_id, "status": gen["status"], "skipped": True}

    params = _load_json(gen["params"]) or {}
    try:
        check_prompt(gen["prompt"])  # defense in depth: web already checked
    except BlockedPromptError as exc:
        _fail_terminal(generation_id, str(exc))
        return {"generationId": generation_id, "status": "refunded", "blocked": True}

    with get_engine().begin() as conn:
        conn.execute(
            text("UPDATE generations SET status='running' WHERE id=:id"),
            {"id": generation_id},
        )

    provider = get_provider()
    takes = 2 if params.get("bestOf2") else 1
    # QC-HOOK: a quality-scoring call would slot in here to auto-pick the best take
    asset_ids: list[str] = []
    music_track_ids: list[str] = []
    errors: list[str] = []

    for _take in range(takes):
        result = provider.generate(gen["kind"], gen["model_slug"], gen["prompt"], params)
        if result.status != "done" or not result.result_paths:
            errors.append(result.error or "generation failed")
            continue
        with get_engine().begin() as conn:
            for i, path in enumerate(result.result_paths):
                if gen["kind"] == "music":
                    music_track_ids.append(
                        _create_music_track(conn, gen["owner_id"], path, gen["prompt"], params)
                    )
                else:
                    asset_ids.append(_create_asset(conn, gen["owner_id"], path, generation_id, i))
        for path in result.result_paths:
            path.unlink(missing_ok=True)

    if not asset_ids and not music_track_ids:
        if job["attempts"] >= MAX_ATTEMPTS:
            _fail_terminal(generation_id, "; ".join(errors)[:400] or "generation failed")
        raise RuntimeError("; ".join(errors)[:400] or "generation failed")

    for asset_id in asset_ids:
        enqueue_job("analyze_media", {"assetId": asset_id}, owner_id=gen["owner_id"], priority=6)
    for track_id in music_track_ids:
        enqueue_job("beats", {"assetId": track_id}, owner_id=gen["owner_id"], priority=6)

    result_ids = asset_ids or music_track_ids
    new_params = {**params, "results": result_ids}
    # Best-of-2 keeps result_asset_id NULL until the user picks a take (§8.3)
    chosen = None if (params.get("bestOf2") and len(result_ids) > 1) else result_ids[0]
    with get_engine().begin() as conn:
        conn.execute(
            text(
                "UPDATE generations SET status='done', result_asset_id=:rid, "
                "params=CAST(:params AS jsonb), vendor_cost_usd=0 WHERE id=:id"
            ),
            {
                "rid": chosen,
                "params": json.dumps(new_params),
                "id": generation_id,
            },
        )
    return {"generationId": generation_id, "status": "done", "results": result_ids}


def _fail_terminal(generation_id: str, error: str) -> None:
    """Terminal failure: mark failed, then refund atomically (§8.4, §5.3)."""
    with get_engine().begin() as conn:
        conn.execute(
            text(
                "UPDATE generations SET status='failed', "
                "params = params || CAST(:extra AS jsonb) WHERE id=:id"
            ),
            {"id": generation_id, "extra": json.dumps({"error": error})},
        )
    refund_generation(generation_id)
