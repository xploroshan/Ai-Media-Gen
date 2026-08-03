"""Auto-edit planner — SPEC §6.4. Pure & deterministic given (inputs, seed).

Emits an edit-spec dict (§5.1). No I/O here; the job handler feeds it data.
"""

from __future__ import annotations

import random
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from worker.lib.labels import VIBE_LABEL_AFFINITY
from worker.lib.scoring import dedupe_clusters

MIN_SLOT_SEC = 0.7
BEAT_SNAP_TOLERANCE = 0.08  # §6.5: cuts within ±80 ms of a beat
LAST_SLOT_FLEX = 0.15  # trim/extend ±15%
QUALITY_FLOOR = 0.35
SHUFFLE_PENALTY = 0.2
SPEED_FIT = (0.85, 1.15)
BURST_CAP = 3
BURST_WINDOW_SEC = 12.0
DEFAULT_TRANSITION_DUR = 0.3


@dataclass
class Candidate:
    id: str
    kind: str  # image|video
    duration_sec: float | None = None
    taken_at: datetime | None = None
    quality: float = 0.5
    tags: list[dict] = field(default_factory=list)
    faces_count: int = 0
    face_area_ratio: float = 0.0
    highlights: list[dict] = field(default_factory=list)
    phash: str | None = None


def synth_beat_grid(target_sec: float, bpm: float = 120.0) -> list[float]:
    interval = 60.0 / bpm
    n = int(target_sec / interval) + 2
    return [round(i * interval, 3) for i in range(n)]


def aesthetic_score(cand: Candidate, vibe_id: str) -> float:
    """CLIP-tag prior: overlap of candidate tags with the vibe's affinity labels."""
    affinity = set(VIBE_LABEL_AFFINITY.get(vibe_id, []))
    if not affinity or not cand.tags:
        return 0.5
    hits = [t["score"] for t in cand.tags if t.get("label") in affinity]
    if not hits:
        return 0.3
    return float(min(1.0, 0.5 + 2.0 * max(hits)))


def face_score(cand: Candidate) -> float:
    return float(min(1.0, cand.faces_count * 0.25 + cand.face_area_ratio * 3.0))


def salience_score(cand: Candidate, vibe_id: str) -> float:
    if cand.kind == "video" and cand.highlights:
        return float(min(1.0, max(h.get("score", 0.0) for h in cand.highlights)))
    return aesthetic_score(cand, vibe_id)


def selection_score(
    cand: Candidate, vibe_id: str, steering: dict | None, excluded: set[str]
) -> float:
    people_bias = float((steering or {}).get("peopleBias") or 0.0)
    w_face = 0.20 + 0.15 * people_bias
    score = (
        0.35 * cand.quality
        + 0.20 * aesthetic_score(cand, vibe_id)
        + w_face * face_score(cand)
        + 0.25 * salience_score(cand, vibe_id)
    )
    if cand.id in excluded:
        score -= SHUFFLE_PENALTY  # §6.4.8 shuffle exclusion penalty
    return score


def filter_candidates(candidates: list[Candidate]) -> tuple[list[Candidate], dict[str, str]]:
    """Quality floor + phash dedupe + burst cap. Returns (kept, cluster_of_asset)."""
    pool = [c for c in candidates if c.quality >= QUALITY_FLOOR]
    if len(pool) < 2:  # degenerate library: fall back to everything rather than an empty reel
        pool = list(candidates)

    hashes = {c.id: c.phash or "" for c in pool if c.phash}
    clusters = dedupe_clusters(hashes) if hashes else []
    cluster_of: dict[str, str] = {}
    for cluster in clusters:
        rep = cluster[0]
        for asset_id in cluster:
            cluster_of[asset_id] = rep

    by_id = {c.id: c for c in pool}
    kept: list[Candidate] = []
    for cluster in clusters:
        members = sorted((by_id[a] for a in cluster if a in by_id),
                         key=lambda c: (-c.quality, c.id))
        kept.extend(members[:1])  # best-scored per near-dupe cluster
    clustered_ids = {c.id for c in kept}
    kept.extend(c for c in pool if c.id not in cluster_of and c.id not in clustered_ids)

    # burst cap: ≤3 per rapid-fire time window
    kept.sort(key=lambda c: (c.taken_at or datetime.min, c.id))
    final: list[Candidate] = []
    burst: list[Candidate] = []
    for cand in kept:
        if (
            burst
            and cand.taken_at
            and burst[-1].taken_at
            and (cand.taken_at - burst[-1].taken_at).total_seconds() <= BURST_WINDOW_SEC
        ):
            burst.append(cand)
        else:
            final.extend(sorted(burst, key=lambda c: (-c.quality, c.id))[:BURST_CAP])
            burst = [cand]
    final.extend(sorted(burst, key=lambda c: (-c.quality, c.id))[:BURST_CAP])
    final.sort(key=lambda c: (c.taken_at or datetime.min, c.id))
    return final, cluster_of


def plan_slots(
    target_sec: float,
    beat_times: list[float],
    energy: list[float] | None,
    pace_low: float,
    pace_high: float,
    steering: dict | None = None,
) -> list[tuple[float, float]]:
    """Beat-snapped slot plan (§6.4.3). Every interior boundary lies on a beat."""
    beats = sorted(b for b in beat_times if 0 < b < target_sec + pace_low)
    if not beats:
        beats = [b for b in synth_beat_grid(target_sec) if b > 0]

    steering = steering or {}
    pace_mult = 1.0
    if steering.get("pace") == "slower":
        pace_mult = 1.3
    elif steering.get("pace") == "faster":
        pace_mult = 0.75
    if steering.get("fewerClips"):
        pace_mult *= 1.5

    def energy_at(t: float) -> float:
        if not energy or not beats:
            return 0.5
        idx = min(range(len(beats)), key=lambda i: abs(beats[i] - t))
        return energy[min(idx, len(energy) - 1)]

    slots: list[tuple[float, float]] = []
    t = 0.0
    while t < target_sec - MIN_SLOT_SEC / 2:
        e = energy_at(t)
        pace = (pace_low + (pace_high - pace_low) * e) * pace_mult
        desired = t + max(MIN_SLOT_SEC, pace)
        snappable = [b for b in beats if b >= t + MIN_SLOT_SEC and b <= target_sec]
        if snappable:
            end = min(snappable, key=lambda b: abs(b - desired))
        else:
            end = min(desired, target_sec)
        if end <= t + 1e-9:
            break
        slots.append((t, end))
        t = end
        if abs(t - target_sec) < 1e-9:
            break

    if not slots:
        return [(0.0, target_sec)]

    # last slot ends exactly at target (±15% flex, else merge into previous)
    start, end = slots[-1]
    nominal = end - start
    stretched = target_sec - start
    if stretched >= MIN_SLOT_SEC and abs(stretched - nominal) <= max(
        LAST_SLOT_FLEX * nominal, 0.35
    ):
        slots[-1] = (start, target_sec)
    elif len(slots) > 1:
        prev_start = slots[-2][0]
        slots.pop()
        slots[-1] = (prev_start, target_sec)
    else:
        slots[-1] = (start, target_sec)
    return slots


def fit_highlight(
    cand: Candidate, slot_dur: float, used_windows: list[tuple[float, float]]
) -> tuple[float, float, float]:
    """(srcIn, srcOut, speed) using the top unused highlight window (§6.4.5)."""
    duration = cand.duration_sec or slot_dur
    windows = sorted(cand.highlights or [], key=lambda h: -h.get("score", 0.0))
    chosen: tuple[float, float] | None = None
    for h in windows:
        win = (float(h["start"]), float(h["end"]))
        if all(win[0] >= ue - 1e-6 or win[1] <= us + 1e-6 for us, ue in used_windows):
            chosen = win
            break
    if chosen is None:
        offset = (len(used_windows) * slot_dur) % max(duration - slot_dur, 0.001)
        chosen = (offset, min(duration, offset + slot_dur))

    hs, he = chosen
    avail = he - hs
    speed = 1.0
    if avail >= slot_dur:
        src_out = hs + slot_dur
    else:
        ratio = avail / slot_dur
        if SPEED_FIT[0] <= ratio <= SPEED_FIT[1]:
            speed = ratio  # slight slow-down fits window to slot
            src_out = he
        else:
            src_out = min(duration, hs + slot_dur)
            if src_out - hs < slot_dur:  # not enough material: start earlier if possible
                hs = max(0.0, src_out - slot_dur)
    return round(hs, 3), round(src_out, 3), round(speed, 3)


def plan_autoedit(
    candidates: list[Candidate],
    vibe_id: str,
    vibe_config: dict,
    aspect: str,
    width: int,
    height: int,
    target_sec: float,
    seed: int,
    beat_times: list[float],
    energy: list[float] | None = None,
    steering: dict | None = None,
    exclude_asset_ids: list[str] | None = None,
    event_title: str | None = None,
    music_track_id: str | None = None,
    music_duration: float | None = None,
    watermark: bool = True,
) -> dict[str, Any]:
    """Deterministic edit-spec (§5.1) from library candidates."""
    rng = random.Random(seed)
    excluded = set(exclude_asset_ids or [])
    steering = steering or {}

    pace = vibe_config.get("paceSec", {"low": 2.2, "high": 1.4})
    beats = sorted(b for b in beat_times if b >= 0) or synth_beat_grid(target_sec)
    # music shorter than the timeline: extrapolate the grid at the median beat
    # interval so late cuts still land on a steady pulse instead of nothing
    if beats[-1] < target_sec - 1e-6:
        if len(beats) >= 2:
            intervals = sorted(
                b2 - b1 for b1, b2 in zip(beats, beats[1:], strict=False) if b2 - b1 > 1e-3
            )
            step = intervals[len(intervals) // 2] if intervals else 0.5
        else:
            step = 0.5
        t = beats[-1] + step
        while t <= target_sec + step:
            beats.append(round(t, 3))
            t += step
    slots = plan_slots(target_sec, beats, energy, pace["low"], pace["high"], steering)

    kept, cluster_of = filter_candidates(candidates)
    if not kept:
        raise ValueError("no usable candidates")

    scored = sorted(
        kept,
        key=lambda c: (-selection_score(c, vibe_id, steering, excluded), c.id),
    )
    n = len(slots)
    pool = scored[:n]

    # ≥40% video when available (§6.4.5)
    videos_avail = [c for c in scored if c.kind == "video"]
    if videos_avail:
        want_videos = max(1, int(0.4 * n)) if n > 1 else 1
        have = sum(1 for c in pool if c.kind == "video")
        if have < want_videos:
            spare_videos = [c for c in videos_avail if c not in pool]
            images_in_pool = [c for c in reversed(pool) if c.kind == "image"]
            for vid, img in zip(spare_videos, images_in_pool, strict=False):
                if have >= want_videos:
                    break
                pool[pool.index(img)] = vid
                have += 1

    # §6.4.8: shuffle must differ on ≥40% of picks. The −0.2 penalty biases the
    # scores; this enforces the floor outright when fresh candidates exist.
    # Runs LAST so no later pass can reintroduce excluded assets. Same-kind swaps
    # preferred to preserve the video ratio.
    if excluded:
        fresh_out = [c for c in scored if c.id not in excluded and c not in pool]
        need = int(-(-0.4 * min(n, len(pool)) // 1))  # ceil
        have = sum(1 for c in pool if c.id not in excluded)
        reused_in_pool = sorted(
            (c for c in pool if c.id in excluded),
            key=lambda c: (selection_score(c, vibe_id, steering, excluded), c.id),
        )
        while have < need and fresh_out and reused_in_pool:
            reused = reused_in_pool.pop(0)
            match = next((f for f in fresh_out if f.kind == reused.kind), fresh_out[0])
            fresh_out.remove(match)
            pool[pool.index(reused)] = match
            have += 1

    # chronological order unless steering says best-moments-first (§6.4.5)
    if steering.get("bestMomentsFirst"):
        ordered = pool
    else:
        ordered = sorted(pool, key=lambda c: (c.taken_at or datetime.min, c.id))

    # no two same-cluster assets adjacent: simple swap pass
    def cluster(c: Candidate) -> str:
        return cluster_of.get(c.id, c.id)

    for i in range(1, len(ordered)):
        if cluster(ordered[i]) == cluster(ordered[i - 1]):
            for j in range(i + 1, len(ordered)):
                if (
                    cluster(ordered[j]) != cluster(ordered[i - 1])
                    and (j == len(ordered) - 1 or cluster(ordered[j - 1]) != cluster(ordered[i]))
                ):
                    ordered[i], ordered[j] = ordered[j], ordered[i]
                    break

    transitions = list(vibe_config.get("transitions", ["cut", "fade"]))
    calm_transitions = [t for t in transitions if t in ("cut", "fade")] or ["cut"]
    kb_cfg = vibe_config.get("kenBurns", {})

    downbeats = set()
    for i, b in enumerate(beats):
        if i % 4 == 0:
            downbeats.add(round(b, 3))

    clips: list[dict] = []
    used_windows: dict[str, list[tuple[float, float]]] = {}
    pan_flip = 1.0 if rng.random() < 0.5 else -1.0
    for idx, (start, end) in enumerate(slots):
        cand = ordered[idx % len(ordered)]
        dur = round(end - start, 3)
        clip: dict[str, Any] = {
            "id": f"c{idx + 1}",
            "assetId": cand.id,
            "kind": "video" if cand.kind == "video" else "image",
            "timelineStart": round(start, 3),
            "duration": dur,
            "speed": 1.0,
            "transform": {"scale": 1.0, "x": 0, "y": 0, "rotate": 0},
        }
        if cand.kind == "video":
            src_in, src_out, speed = fit_highlight(cand, dur, used_windows.setdefault(cand.id, []))
            used_windows[cand.id].append((src_in, src_out))
            clip.update(srcIn=src_in, srcOut=src_out, speed=speed)
        else:
            # kenBurns per vibe, direction alternating via seeded RNG (§6.4.6)
            style = kb_cfg.get("style", "slow")
            if style == "quick-zoom-in":
                from_scale, to_scale = 1.0, 1.22
            elif style == "minimal":
                from_scale, to_scale = 1.0, 1.06
            else:
                from_scale, to_scale = 1.05, 1.18
            pan = 0.03 * pan_flip if kb_cfg.get("alternatePan") else 0.02
            if kb_cfg.get("alternatePan"):
                pan_flip *= -1.0
            clip["kenBurns"] = {
                "fromScale": from_scale,
                "toScale": to_scale,
                "panX": round(pan, 3),
                "panY": 0,
            }
        if idx < len(slots) - 1:
            on_downbeat = round(end, 3) in downbeats
            allowed = transitions if on_downbeat else calm_transitions
            t_type = rng.choice(sorted(allowed))
            if t_type != "cut":
                t_dur = min(DEFAULT_TRANSITION_DUR, round(dur * 0.4, 2))
                clip["transitionAfter"] = {"type": t_type, "duration": t_dur}
            else:
                clip["transitionAfter"] = {"type": "cut", "duration": 0}
        clips.append(clip)

    text_clips: list[dict] = []
    if event_title:
        text_clips.append(
            {
                "id": "title1",
                "text": event_title,
                "start": 0.2,
                "end": min(2.2, target_sec - 0.1),
                "styleId": vibe_config.get("captionStyle", "title-bold"),
                "pos": "center",
                "animate": "pop",
            }
        )

    audio_clips: list[dict] = []
    if music_track_id:
        audio_clips.append(
            {
                "id": "m1",
                "assetId": music_track_id,
                "timelineStart": 0,
                "srcIn": 0.0,
                "gainDb": 0,
                "duckUnderSpeechDb": -10,
            }
        )

    color_cfg = vibe_config.get("color", {})
    return {
        "version": 1,
        "aspect": aspect,
        "width": width,
        "height": height,
        "fps": 30,
        "durationSec": float(target_sec),
        "tracks": [
            {"id": "v1", "type": "video", "clips": clips},
            {"id": "t1", "type": "text", "clips": text_clips},
            {"id": "a1", "type": "audio", "clips": audio_clips},
        ],
        "captions": {"enabled": False, "styleId": "karaoke-yellow", "lang": "en", "words": []},
        "color": {
            "lut": None,
            "brightness": float(color_cfg.get("brightness", 0)),
            "contrast": float(color_cfg.get("contrast", 0)),
            "saturation": float(color_cfg.get("saturation", 0)),
        },
        "watermark": {"enabled": watermark},
        "meta": {
            "vibeId": vibe_id,
            "seed": seed,
            "beatTimes": [round(b, 3) for b in beats if b <= target_sec],
            **({"eventTitle": event_title} if event_title else {}),
            **({"musicTrackId": music_track_id} if music_track_id else {}),
        },
    }
