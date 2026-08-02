"""autoedit_generate handler — §6.4 orchestration (planner itself is pure)."""

from __future__ import annotations

import json
from typing import Any

from sqlalchemy import text

from worker.jobs import register
from worker.lib.autoedit import Candidate, plan_autoedit, synth_beat_grid
from worker.lib.db import enqueue_job, get_engine


def _load_json(value: Any) -> Any:
    if isinstance(value, str):
        return json.loads(value)
    return value


def _candidates_for(asset_rows: list[dict]) -> list[Candidate]:
    out = []
    for row in asset_rows:
        if row["kind"] not in ("image", "video"):
            continue
        tags = _load_json(row.get("tags")) or []
        highlights = _load_json(row.get("highlights")) or []
        out.append(
            Candidate(
                id=row["id"],
                kind=row["kind"],
                duration_sec=row.get("duration_sec"),
                taken_at=row.get("taken_at"),
                quality=float(row.get("quality_score") or 0.5),
                tags=tags,
                faces_count=int(row.get("faces_count") or 0),
                face_area_ratio=float(row.get("face_area_ratio") or 0.0),
                highlights=highlights,
                phash=row.get("phash"),
            )
        )
    return out


def _pick_music(conn, vibe_id: str, music_track_id: str | None) -> dict | None:
    if music_track_id:
        row = conn.execute(
            text("SELECT * FROM music_tracks WHERE id=:id"), {"id": music_track_id}
        ).mappings().first()
        if row:
            return dict(row)
    rows = conn.execute(text("SELECT * FROM music_tracks WHERE owner_id IS NULL")).mappings().all()
    for row in rows:  # prefer a vibe-tagged seed track (§6.4.2)
        tags = _load_json(row.get("vibe_tags")) or []
        if vibe_id in tags:
            return dict(row)
    return dict(rows[0]) if rows else None


@register("autoedit_generate")
def handle(job: dict) -> dict:
    payload = job["payload"]
    project_id = payload["projectId"]

    with get_engine().begin() as conn:
        project = conn.execute(
            text("SELECT * FROM projects WHERE id=:id"), {"id": project_id}
        ).mappings().first()
        if project is None:
            raise RuntimeError(f"project {project_id} not found")
        vibe = conn.execute(
            text("SELECT * FROM vibes WHERE id=:id"), {"id": payload["vibeId"]}
        ).mappings().first()
        if vibe is None:
            raise RuntimeError(f"vibe {payload['vibeId']} not found")
        asset_rows = conn.execute(
            text(
                "SELECT a.*, an.quality_score, an.tags, an.highlights, an.faces_count, "
                "an.face_area_ratio FROM media_assets a "
                "LEFT JOIN media_analysis an ON an.asset_id=a.id "
                "WHERE a.id = ANY(:ids) AND a.status='ready'"
            ),
            {"ids": payload["assetIds"]},
        ).mappings().all()
        prior_spec = _load_json(project["edit_spec"]) or {}
        music_track_id = (prior_spec.get("meta") or {}).get("musicTrackId")
        music = _pick_music(conn, payload["vibeId"], music_track_id)
        event_title = None
        event_row = conn.execute(
            text(
                "SELECT title FROM events WHERE owner_id=:o AND asset_ids @> CAST(:ids AS jsonb) "
                "LIMIT 1"
            ),
            {"o": project["owner_id"], "ids": json.dumps(payload["assetIds"][:1])},
        ).mappings().first()
        if event_row:
            event_title = event_row["title"]

    candidates = _candidates_for([dict(r) for r in asset_rows])
    if not candidates:
        raise RuntimeError("no ready image/video assets among the selection")

    beat_times: list[float] = []
    energy = None
    music_duration = None
    if music:
        beat_times = _load_json(music.get("beat_times")) or []
        music_duration = float(music.get("duration_sec") or 0) or None
    if not beat_times:
        beat_times = synth_beat_grid(float(payload["targetSec"]))

    vibe_config = _load_json(vibe["config"])
    spec = plan_autoedit(
        candidates=candidates,
        vibe_id=payload["vibeId"],
        vibe_config=vibe_config,
        aspect=project["aspect"],
        width=1080 if project["aspect"] != "16:9" else 1920,
        height={"9:16": 1920, "4:5": 1350, "1:1": 1080, "16:9": 1080}.get(project["aspect"], 1920),
        target_sec=float(payload["targetSec"]),
        seed=int(payload["seed"]),
        beat_times=beat_times,
        energy=energy,
        steering=payload.get("steering"),
        exclude_asset_ids=payload.get("excludeAssetIds"),
        event_title=event_title,
        music_track_id=music["id"] if music else None,
        music_duration=music_duration,
    )

    with get_engine().begin() as conn:
        conn.execute(
            text(
                "UPDATE projects SET edit_spec=CAST(:spec AS jsonb), vibe_id=:vibe, "
                "preset_id=:preset, seed=:seed, status='rendering', updated_at=now() "
                "WHERE id=:id"
            ),
            {
                "spec": json.dumps(spec),
                "vibe": payload["vibeId"],
                "preset": payload["presetId"],
                "seed": int(payload["seed"]),
                "id": project_id,
            },
        )
    render_job = enqueue_job(
        "render_preview", {"projectId": project_id}, owner_id=project["owner_id"], priority=3
    )
    return {"projectId": project_id, "clips": len(
        next(t for t in spec["tracks"] if t["type"] == "video")["clips"]
    ), "renderJobId": render_job}
