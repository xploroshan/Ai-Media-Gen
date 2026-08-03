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


class _Superseded(Exception):
    """The generation row was reconciled/refunded while we were working."""


def _checkpoint(conn, generation_id: str, params: dict) -> None:
    """Persist take progress in the SAME tx as asset creation, lease-style guarded
    on status='running' — a reconciled/refunded row must not gain new results."""
    count = conn.execute(
        text(
            "UPDATE generations SET params=CAST(:params AS jsonb) "
            "WHERE id=:id AND status='running'"
        ),
        {"params": json.dumps(params), "id": generation_id},
    ).rowcount
    if count == 0:
        raise _Superseded(generation_id)


@register("generate_ai")
def handle(job: dict) -> dict:
    generation_id = job["payload"]["generationId"]
    with get_engine().begin() as conn:
        gen = conn.execute(
            text("SELECT * FROM generations WHERE id=:id"), {"id": generation_id}
        ).mappings().first()
    if gen is None:
        raise RuntimeError(f"generation {generation_id} not found")
    if gen["status"] in ("done", "refunded", "failed"):
        return {"generationId": generation_id, "status": gen["status"], "skipped": True}

    params = _load_json(gen["params"]) or {}
    try:
        check_prompt(gen["prompt"])  # defense in depth: web already checked
    except BlockedPromptError as exc:
        _fail_terminal(generation_id, str(exc))
        return {"generationId": generation_id, "status": "refunded", "blocked": True}

    with get_engine().begin() as conn:
        claimed = conn.execute(
            text(
                "UPDATE generations SET status='running' "
                "WHERE id=:id AND status IN ('queued','running')"
            ),
            {"id": generation_id},
        ).rowcount
    if claimed == 0:  # reconciler refunded it between our read and now
        return {"generationId": generation_id, "status": "superseded", "skipped": True}

    provider = get_provider()
    takes = 2 if params.get("bestOf2") else 1
    # QC-HOOK: a quality-scoring call would slot in here to auto-pick the best take
    # resume from a prior crashed attempt's checkpoint (§5.3 retries)
    result_ids: list[str] = list(params.get("results") or [])
    takes_done: int = int(params.get("takesDone") or 0)
    errors: list[str] = []
    vendor_cost = 0.0
    vendor_cost_known = False

    try:
        # takes_done counts DELIVERED takes; a failed take is simply re-attempted
        # on the next retry (the checkpoint resumes with the delivered ones kept)
        for _ in range(max(0, takes - takes_done)):
            result = provider.generate(gen["kind"], gen["model_slug"], gen["prompt"], params)
            if result.status != "done" or not result.result_paths:
                errors.append(result.error or "generation failed")
                continue
            if result.cost_usd is not None:
                vendor_cost += result.cost_usd
                vendor_cost_known = True
            with get_engine().begin() as conn:
                for i, path in enumerate(result.result_paths):
                    if gen["kind"] == "music":
                        result_ids.append(
                            _create_music_track(conn, gen["owner_id"], path, gen["prompt"], params)
                        )
                    else:
                        result_ids.append(
                            _create_asset(conn, gen["owner_id"], path, generation_id, i)
                        )
                takes_done += 1
                params = {**params, "results": result_ids, "takesDone": takes_done}
                _checkpoint(conn, generation_id, params)
            for path in result.result_paths:
                path.unlink(missing_ok=True)
    except _Superseded:
        return {"generationId": generation_id, "status": "superseded", "skipped": True}

    error_text = "; ".join(errors)[:400] or "generation failed"
    if not result_ids:
        if job["attempts"] >= MAX_ATTEMPTS:
            _fail_terminal(generation_id, error_text)
            return {"generationId": generation_id, "status": "refunded"}
        raise RuntimeError(error_text)
    if takes_done < takes and job["attempts"] < MAX_ATTEMPTS:
        # partial best-of-2: retry the missing take (checkpoint resumes from here)
        raise RuntimeError(f"partial results ({takes_done}/{takes} takes): {error_text}")

    # Best-of-2 keeps result_asset_id NULL until the user picks a take (§8.3)
    chosen = None if (params.get("bestOf2") and len(result_ids) > 1) else result_ids[0]
    missing_takes = max(0, takes - takes_done)
    per_take_cost = int(gen["credit_cost"]) // takes if takes else 0
    refund = per_take_cost * missing_takes

    with get_engine().begin() as conn:
        count = conn.execute(
            text(
                "UPDATE generations SET status='done', result_asset_id=:rid, "
                "params=CAST(:params AS jsonb), vendor_cost_usd=:vc, "
                "credit_cost=credit_cost - :refund "
                "WHERE id=:id AND status='running'"
            ),
            {
                "rid": chosen,
                "params": json.dumps({**params, "results": result_ids}),
                "vc": round(vendor_cost, 4) if vendor_cost_known else None,
                "refund": refund,
                "id": generation_id,
            },
        ).rowcount
        if count == 0:  # superseded mid-flight — do not deliver or refund
            return {"generationId": generation_id, "status": "superseded", "skipped": True}
        if refund > 0:
            profile = conn.execute(
                text("SELECT credits_balance FROM profiles WHERE id=:id FOR UPDATE"),
                {"id": gen["owner_id"]},
            ).mappings().one()
            new_balance = profile["credits_balance"] + refund
            conn.execute(
                text(
                    "INSERT INTO credit_ledger (id, owner_id, delta, reason, ref_id, "
                    "balance_after, created_at) VALUES "
                    "(substr(md5(random()::text || clock_timestamp()::text), 1, 25), "
                    ":owner, :delta, 'partial_refund', :ref, :bal, now())"
                ),
                {"owner": gen["owner_id"], "delta": refund, "ref": generation_id,
                 "bal": new_balance},
            )
            conn.execute(
                text("UPDATE profiles SET credits_balance=:bal WHERE id=:id"),
                {"bal": new_balance, "id": gen["owner_id"]},
            )

    # only a committed 'done' delivers results downstream
    for rid in result_ids:
        if gen["kind"] == "music":
            enqueue_job("beats", {"assetId": rid}, owner_id=gen["owner_id"], priority=6)
        else:
            enqueue_job("analyze_media", {"assetId": rid}, owner_id=gen["owner_id"], priority=6)

    return {"generationId": generation_id, "status": "done", "results": result_ids,
            "partialRefund": refund}


def _fail_terminal(generation_id: str, error: str) -> None:
    """Terminal failure: record the error, then refund atomically (§8.4, §5.3).

    The status flip happens inside refund_generation (to 'refunded', or 'failed'
    for zero-cost rows) so there is no window where a failed generation holds
    unrefunded credits.
    """
    with get_engine().begin() as conn:
        conn.execute(
            text(
                "UPDATE generations SET params = params || CAST(:extra AS jsonb) "
                "WHERE id=:id AND status NOT IN ('done','refunded')"
            ),
            {"id": generation_id, "extra": json.dumps({"error": error})},
        )
    refund_generation(generation_id)
