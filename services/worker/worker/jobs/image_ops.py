"""image_op handler — SPEC §6.7. Every op creates a NEW derived asset.

Originals are immutable (CLAUDE.md guardrail); `synthetic` stays false for
cleanup ops.
"""

from __future__ import annotations

import tempfile
from pathlib import Path

from sqlalchemy import text

from worker.jobs import register
from worker.lib import assets, s3
from worker.lib.db import enqueue_job, get_engine
from worker.lib.image_ops_lib import bg_remove, enhance, erase, upscale
from worker.lib.settings import get_settings

OPS = {"enhance", "bg_remove", "erase", "upscale"}


def _create_derived_asset(source: dict, out_path: Path, op: str) -> str:
    settings = get_settings()
    ext = out_path.suffix.lstrip(".")
    base = Path(source["filename"]).stem
    with get_engine().begin() as conn:
        row = conn.execute(
            text(
                "INSERT INTO media_assets (id, owner_id, kind, status, storage_key, filename, "
                "bytes, synthetic, taken_at, created_at) VALUES "
                "(substr(md5(random()::text || clock_timestamp()::text), 1, 25), "
                ":owner, 'image', 'analyzing', 'pending', :filename, :bytes, "
                ":synthetic, :taken, now()) RETURNING id"
            ),
            {
                "owner": source["owner_id"],
                "filename": f"{base}-{op}.{ext}",
                "bytes": out_path.stat().st_size,
                "synthetic": bool(source.get("synthetic")),  # cleanup keeps original flag
                "taken": source.get("taken_at"),
            },
        ).first()
        assert row is not None
        asset_id = row[0]
        key = f"{settings.bucket_derived}/{source['owner_id']}/{asset_id}.{ext}"
        conn.execute(
            text("UPDATE media_assets SET storage_key=:k WHERE id=:id"),
            {"k": key, "id": asset_id},
        )
    s3.upload_file(out_path, key)
    return asset_id


@register("image_op")
def handle(job: dict) -> dict:
    payload = job["payload"]
    asset_id = payload["assetId"]
    op = payload["op"]
    params = payload.get("params") or {}
    if op not in OPS:
        raise RuntimeError(f"unknown image op {op!r}")

    source = assets.get_asset(asset_id)
    if source is None:
        raise RuntimeError(f"asset {asset_id} not found")
    if source["kind"] != "image":
        raise RuntimeError("image ops require an image asset")

    local = s3.download_to_tmp(source["storage_key"])
    try:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            if op == "enhance":
                import cv2

                img = cv2.imread(str(local), cv2.IMREAD_COLOR)
                if img is None:
                    raise RuntimeError("unreadable image")
                out = tmp / "enhanced.jpg"
                cv2.imwrite(str(out), enhance(img), [cv2.IMWRITE_JPEG_QUALITY, 92])
            elif op == "bg_remove":
                out = bg_remove(local, tmp / "cutout.png")
            elif op == "erase":
                mask_key = params.get("maskKey")
                if not mask_key:
                    raise RuntimeError("erase requires params.maskKey")
                mask_local = s3.download_to_tmp(mask_key)
                try:
                    suffix = local.suffix.lower() if local.suffix else ".jpg"
                    out = erase(local, mask_local, tmp / f"erased{suffix}")
                finally:
                    mask_local.unlink(missing_ok=True)
            else:  # upscale
                model_path = Path(get_settings().model_cache_dir) / "RealESRGAN_x2plus.pth"
                if not model_path.exists():
                    raise RuntimeError("RealESRGAN weights missing from model cache")
                suffix = local.suffix.lower() if local.suffix else ".jpg"
                out = upscale(local, tmp / f"upscaled{suffix}", model_path)

            derived_id = _create_derived_asset(source, out, op)
    finally:
        local.unlink(missing_ok=True)

    enqueue_job("analyze_media", {"assetId": derived_id}, owner_id=source["owner_id"], priority=6)
    return {"assetId": asset_id, "derivedAssetId": derived_id, "op": op}
