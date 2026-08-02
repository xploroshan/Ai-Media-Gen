"""DB access for media_assets / media_analysis / events (SQLAlchemy Core, Prisma-owned schema)."""

from __future__ import annotations

import json
from datetime import datetime
from typing import Any

from sqlalchemy import text

from worker.lib.db import get_engine


def get_asset(asset_id: str) -> dict[str, Any] | None:
    with get_engine().begin() as conn:
        row = (
            conn.execute(text("SELECT * FROM media_assets WHERE id=:id"), {"id": asset_id})
            .mappings()
            .first()
        )
    return dict(row) if row else None


def update_asset(asset_id: str, **fields: Any) -> None:
    if not fields:
        return
    cols = ", ".join(f"{k}=:{k}" for k in fields)
    with get_engine().begin() as conn:
        conn.execute(text(f"UPDATE media_assets SET {cols} WHERE id=:_id"),
                     {**fields, "_id": asset_id})


def upsert_analysis(asset_id: str, **fields: Any) -> None:
    json_cols = {
        "tags", "clip_embedding", "scene_cuts", "highlights", "beat_times", "transcript"
    }
    payload = {}
    for key, value in fields.items():
        payload[key] = json.dumps(value) if key in json_cols and value is not None else value
    cols = ["asset_id", *payload.keys()]
    insert_vals = ", ".join(
        f"CAST(:{c} AS jsonb)" if c in json_cols else f":{c}" for c in cols if c != "asset_id"
    )
    updates = ", ".join(
        f"{c}=CAST(:{c} AS jsonb)" if c in json_cols else f"{c}=:{c}"
        for c in payload
    )
    sql = (
        f"INSERT INTO media_analysis (asset_id{', ' if payload else ''}{', '.join(payload)}) "
        f"VALUES (:asset_id{', ' if payload else ''}{insert_vals}) "
        f"ON CONFLICT (asset_id) DO UPDATE SET {updates}" if payload else
        "INSERT INTO media_analysis (asset_id) VALUES (:asset_id) ON CONFLICT DO NOTHING"
    )
    with get_engine().begin() as conn:
        conn.execute(text(sql), {"asset_id": asset_id, **payload})


def get_analysis(asset_id: str) -> dict[str, Any] | None:
    with get_engine().begin() as conn:
        row = (
            conn.execute(
                text("SELECT * FROM media_analysis WHERE asset_id=:id"), {"id": asset_id}
            )
            .mappings()
            .first()
        )
    return dict(row) if row else None


def list_ready_assets(owner_id: str) -> list[dict[str, Any]]:
    with get_engine().begin() as conn:
        rows = (
            conn.execute(
                text(
                    "SELECT a.*, an.quality_score, an.tags, an.highlights, an.faces_count, "
                    "an.face_area_ratio, an.scene_cuts, an.beat_times "
                    "FROM media_assets a LEFT JOIN media_analysis an ON an.asset_id = a.id "
                    "WHERE a.owner_id=:o AND a.status='ready' "
                    "ORDER BY COALESCE(a.taken_at, a.created_at)"
                ),
                {"o": owner_id},
            )
            .mappings()
            .all()
        )
    return [dict(r) for r in rows]


def upsert_event(
    owner_id: str, title: str, start_at: datetime, end_at: datetime, asset_ids: list[str]
) -> str:
    """Non-destructive upsert keyed on overlapping [start,end] window (SPEC §6.2)."""
    with get_engine().begin() as conn:
        existing = (
            conn.execute(
                text(
                    "SELECT id FROM events WHERE owner_id=:o "
                    "AND start_at <= :e AND end_at >= :s LIMIT 1"
                ),
                {"o": owner_id, "s": start_at, "e": end_at},
            )
            .mappings()
            .first()
        )
        if existing:
            event_id = existing["id"]
            conn.execute(
                text(
                    "UPDATE events SET title=:t, start_at=:s, end_at=:e, "
                    "asset_ids=CAST(:ids AS jsonb) WHERE id=:id"
                ),
                {
                    "t": title, "s": start_at, "e": end_at,
                    "ids": json.dumps(asset_ids), "id": event_id,
                },
            )
        else:
            row = conn.execute(
                text(
                    "INSERT INTO events (id, owner_id, title, start_at, end_at, asset_ids) "
                    "VALUES (substr(md5(random()::text || clock_timestamp()::text), 1, 25), "
                    ":o, :t, :s, :e, CAST(:ids AS jsonb)) RETURNING id"
                ),
                {"o": owner_id, "t": title, "s": start_at, "e": end_at,
                 "ids": json.dumps(asset_ids)},
            ).first()
            assert row is not None
            event_id = row[0]
        conn.execute(
            text("UPDATE media_assets SET event_id=:ev WHERE id = ANY(:ids)"),
            {"ev": event_id, "ids": asset_ids},
        )
    return event_id
