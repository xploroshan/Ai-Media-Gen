"""analyze_media handler — SPEC §6.1, implemented step-for-step.

On any step failure: status='failed' with reason, but partial analysis is kept.
"""

from __future__ import annotations

import logging
import tempfile
from pathlib import Path
from typing import Any

import numpy as np

from worker.jobs import register
from worker.lib import assets, clip_embed, exif, faces, ffmpeg, s3, scoring
from worker.lib.db import get_engine
from worker.lib.settings import get_settings

log = logging.getLogger("worker.analyze")

MOTION_SAMPLE_FPS = 2.0
AUDIO_HOP_SEC = 0.5


def _derived_key(owner_id: str, asset_id: str, name: str) -> str:
    bucket = get_settings().bucket_derived
    return f"{bucket}/{owner_id}/{asset_id}/{name}"


def _analyze_image(
    asset: dict, local: Path, tmp: Path, updates: dict[str, Any], analysis: dict[str, Any]
) -> None:
    import cv2
    from PIL import Image

    with Image.open(local) as img:
        updates["width"], updates["height"] = img.size
    meta = exif.read_exif(local)
    if meta["takenAt"]:
        updates["taken_at"] = meta["takenAt"]
    updates["gps_lat"], updates["gps_lng"] = meta["gpsLat"], meta["gpsLng"]

    # thumb 512px JPEG
    thumb_path = tmp / "thumb_0.jpg"
    with Image.open(local) as img:
        img = img.convert("RGB")
        img.thumbnail((512, 512))
        img.save(thumb_path, "JPEG", quality=88)
    thumb_key = _derived_key(asset["owner_id"], asset["id"], "thumb_0.jpg")
    s3.upload_file(thumb_path, thumb_key, "image/jpeg")
    updates["thumb_key"] = thumb_key

    # quality
    gray = cv2.imread(str(local), cv2.IMREAD_GRAYSCALE)
    if gray is None:
        raise RuntimeError("unreadable image for quality scoring")
    bv = scoring.blur_var(gray)
    expo = scoring.exposure_score(gray)
    res = scoring.resolution_score(updates.get("width"), updates.get("height"))
    analysis["blur_var"] = bv
    analysis["exposure_score"] = expo
    analysis["quality_score"] = scoring.quality_score(bv, expo, res)

    # CLIP tags + embedding on the image itself
    embedding = clip_embed.embed_image(local)
    analysis["clip_embedding"] = [round(float(x), 5) for x in embedding]
    analysis["tags"] = clip_embed.top_tags(embedding)

    # faces (detection only)
    count, ratio = faces.detect_faces(local)
    analysis["faces_count"] = count
    analysis["face_area_ratio"] = ratio

    # phash
    import imagehash
    from PIL import Image as PILImage

    with PILImage.open(local) as img:
        updates["phash"] = str(imagehash.phash(img))


def _video_motion_and_audio(local: Path, duration: float, tmp: Path) -> tuple[np.ndarray, float]:
    """Combined per-hop score 0.6*motion + 0.4*audioEnergy at AUDIO_HOP_SEC grid."""
    import cv2

    n_hops = max(1, int(duration / AUDIO_HOP_SEC))

    # motion: mean abs frame diff at ~2 fps — sequential grab() with frame
    # skipping instead of per-sample seeks (CAP_PROP_POS_MSEC seeks re-decode
    # from the previous keyframe every time and dominated analysis runtime)
    cap = cv2.VideoCapture(str(local))
    motion = np.zeros(n_hops, dtype=np.float64)
    prev = None
    src_fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    if not src_fps or src_fps <= 0:
        src_fps = 30.0
    frame_step = max(1, int(round(src_fps / MOTION_SAMPLE_FPS)))
    frame_idx = 0
    while True:
        if not cap.grab():
            break
        if frame_idx % frame_step == 0:
            t = frame_idx / src_fps
            if t >= duration:
                break
            ok, frame = cap.retrieve()
            if not ok:
                break
            small = cv2.resize(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY), (160, 90))
            if prev is not None:
                diff = float(np.mean(np.abs(small.astype(np.int16) - prev.astype(np.int16))))
                hop = min(n_hops - 1, int(t / AUDIO_HOP_SEC))
                motion[hop] = max(motion[hop], diff)
            prev = small
        frame_idx += 1
    cap.release()
    if motion.max() > 0:
        motion = motion / motion.max()

    # audio RMS energy (librosa, 0.5 s hop)
    audio = np.zeros(n_hops, dtype=np.float64)
    wav = ffmpeg.extract_wav(local, tmp / "audio.wav")
    if wav is not None:
        import librosa

        y, sr = librosa.load(str(wav), sr=22050, mono=True)
        hop_len = int(sr * AUDIO_HOP_SEC)
        if len(y):
            rms = librosa.feature.rms(y=y, frame_length=hop_len, hop_length=hop_len)[0]
            for i in range(min(n_hops, len(rms))):
                audio[i] = rms[i]
            if audio.max() > 0:
                audio = audio / audio.max()

    return 0.6 * motion + 0.4 * audio, AUDIO_HOP_SEC


def _analyze_video(
    asset: dict, local: Path, tmp: Path, updates: dict[str, Any], analysis: dict[str, Any]
) -> None:
    import cv2

    probe = ffmpeg.probe_summary(local)
    if not probe["hasVideo"]:
        raise RuntimeError("no video stream")
    duration = probe["durationSec"] or 0.0
    updates.update(
        width=probe["width"], height=probe["height"],
        duration_sec=duration, fps=probe["fps"],
    )
    if probe["creationTime"]:
        updates["taken_at"] = probe["creationTime"]

    # thumbs at 10/50/90%
    thumb_keys = []
    for i, frac in enumerate((0.10, 0.50, 0.90)):
        frame = tmp / f"thumb_{i}.jpg"
        ffmpeg.extract_frame(local, duration * frac, frame)
        key = _derived_key(asset["owner_id"], asset["id"], f"thumb_{i}.jpg")
        s3.upload_file(frame, key, "image/jpeg")
        thumb_keys.append(key)
    updates["thumb_key"] = thumb_keys[0]  # first = cover

    # 540p proxy
    proxy = tmp / "proxy.mp4"
    ffmpeg.make_proxy(local, proxy)
    proxy_key = _derived_key(asset["owner_id"], asset["id"], "proxy.mp4")
    s3.upload_file(proxy, proxy_key, "video/mp4")
    updates["proxy_key"] = proxy_key

    # scene cuts (PySceneDetect ContentDetector threshold=27)
    from scenedetect import ContentDetector, detect

    scenes = detect(str(local), ContentDetector(threshold=27.0))
    cuts = [round(scene[0].get_seconds(), 3) for scene in scenes if scene[0].get_seconds() > 0]
    analysis["scene_cuts"] = cuts

    # per-scene middle-frame quality; asset score = mean of top-3 scenes
    boundaries = [0.0, *cuts, duration]
    mids = [
        (boundaries[i] + boundaries[i + 1]) / 2
        for i in range(len(boundaries) - 1)
        if boundaries[i + 1] - boundaries[i] > 0.2
    ] or [duration / 2]
    res = scoring.resolution_score(probe["width"], probe["height"])
    scene_scores = []
    for mid in mids[:12]:
        frame_path = tmp / "scene_frame.jpg"
        try:
            ffmpeg.extract_frame(local, mid, frame_path, width=640)
            gray = cv2.imread(str(frame_path), cv2.IMREAD_GRAYSCALE)
            if gray is None:
                continue
            bv = scoring.blur_var(gray)
            expo = scoring.exposure_score(gray)
            scene_scores.append(scoring.quality_score(bv, expo, res))
        except ffmpeg.FfmpegError:
            continue
    if scene_scores:
        top3 = sorted(scene_scores, reverse=True)[:3]
        analysis["quality_score"] = float(np.mean(top3))

    # highlights: top-5 windows by 0.6*motion + 0.4*audioEnergy
    combined, hop = _video_motion_and_audio(local, duration, tmp)
    analysis["highlights"] = scoring.top_windows(combined, hop, duration)

    # cover-frame CLIP + faces + phash
    cover = tmp / "cover.jpg"
    ffmpeg.extract_frame(local, duration * 0.10, cover)
    embedding = clip_embed.embed_image(cover)
    analysis["clip_embedding"] = [round(float(x), 5) for x in embedding]
    analysis["tags"] = clip_embed.top_tags(embedding)
    count, ratio = faces.detect_faces(cover)
    analysis["faces_count"] = count
    analysis["face_area_ratio"] = ratio

    import imagehash
    from PIL import Image

    with Image.open(cover) as img:
        updates["phash"] = str(imagehash.phash(img))


def _analyze_audio(
    asset: dict, local: Path, tmp: Path, updates: dict[str, Any], analysis: dict[str, Any]
) -> None:
    probe = ffmpeg.probe_summary(local)
    updates["duration_sec"] = probe["durationSec"]
    wav = ffmpeg.extract_wav(local, tmp / "audio.wav")
    if wav is not None:
        import librosa

        y, sr = librosa.load(str(wav), sr=22050, mono=True)
        tempo, beats = librosa.beat.beat_track(y=y, sr=sr, units="time")
        analysis["beat_times"] = [round(float(b), 3) for b in beats]


def _maybe_enqueue_detect_events(owner_id: str) -> None:
    """Enqueue clustering when there are unclustered ready assets and no queued job.

    The check and the insert share one transaction under a per-owner advisory
    lock, so two analyze jobs finishing together can't both enqueue.
    """
    import json

    from sqlalchemy import text

    with get_engine().begin() as conn:
        conn.execute(
            text("SELECT pg_advisory_xact_lock(hashtext('detect_events:' || :o))"),
            {"o": owner_id},
        )
        pending = conn.execute(
            text(
                "SELECT count(*) FROM jobs WHERE type='detect_events' "
                "AND status IN ('queued','running') AND owner_id=:o"
            ),
            {"o": owner_id},
        ).scalar()
        analyzing = conn.execute(
            text(
                "SELECT count(*) FROM media_assets WHERE owner_id=:o "
                "AND status IN ('uploading','analyzing')"
            ),
            {"o": owner_id},
        ).scalar()
        if not pending and not analyzing:
            conn.execute(
                text(
                    "INSERT INTO jobs (id, type, status, priority, payload, owner_id, "
                    "created_at) VALUES "
                    "(substr(md5(random()::text || clock_timestamp()::text), 1, 25), "
                    "'detect_events', 'queued', 7, CAST(:payload AS jsonb), :o, now())"
                ),
                {"payload": json.dumps({"ownerId": owner_id}), "o": owner_id},
            )


@register("analyze_media")
def handle(job: dict) -> dict:
    asset_id = job["payload"]["assetId"]
    asset = assets.get_asset(asset_id)
    if asset is None:
        raise RuntimeError(f"asset {asset_id} not found")

    assets.update_asset(asset_id, status="analyzing")
    # analyzers accumulate into these as they go, so a mid-pipeline failure
    # still persists everything computed so far (SPEC §6.1.8)
    updates: dict[str, Any] = {}
    analysis: dict[str, Any] = {}
    local: Path | None = None
    try:
        local = s3.download_to_tmp(asset["storage_key"])
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            if asset["kind"] == "image":
                _analyze_image(asset, local, tmp, updates, analysis)
            elif asset["kind"] == "video":
                _analyze_video(asset, local, tmp, updates, analysis)
            elif asset["kind"] == "audio":
                _analyze_audio(asset, local, tmp, updates, analysis)
            else:
                raise RuntimeError(f"unknown media kind {asset['kind']!r}")
    except Exception as exc:
        # SPEC §6.1.8: keep partial analysis, mark failed with reason
        try:
            if analysis:
                assets.upsert_analysis(asset_id, **analysis)
            assets.update_asset(asset_id, status="failed", **updates)
        except Exception:  # persist is best-effort; the failure below still surfaces
            log.exception("failed to persist partial analysis for %s", asset_id)
            assets.update_asset(asset_id, status="failed")
        raise RuntimeError(f"analysis failed: {exc}") from exc
    finally:
        if local is not None:
            local.unlink(missing_ok=True)

    if analysis:
        assets.upsert_analysis(asset_id, **analysis)
    assets.update_asset(asset_id, status="ready", **updates)

    _maybe_enqueue_detect_events(asset["owner_id"])
    return {"assetId": asset_id, "status": "ready"}
