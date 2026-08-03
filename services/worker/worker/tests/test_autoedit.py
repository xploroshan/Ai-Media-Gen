"""P2 exit tests — determinism / shuffle / beat-sync / duration properties (SPEC §10 P2, §6.5)."""

import json
from datetime import datetime, timedelta

import pytest

from worker.lib.autoedit import (
    BEAT_SNAP_TOLERANCE,
    MIN_SLOT_SEC,
    Candidate,
    plan_autoedit,
    plan_slots,
    synth_beat_grid,
)

VIBES = {
    "travel-cinematic": {
        "paceSec": {"low": 2.8, "high": 1.6},
        "transitions": ["fade", "zoom"],
        "captionStyle": "title-serif-white",
        "kenBurns": {"style": "slow", "alternatePan": True},
        "color": {"saturation": 0.15},
    },
    "birthday-fun": {
        "paceSec": {"low": 1.6, "high": 0.9},
        "transitions": ["cut", "slideleft"],
        "captionStyle": "pop-bold-yellow",
        "kenBurns": {"style": "quick-zoom-in", "alternatePan": False},
        "color": {"brightness": 0.1},
    },
    "product-promo": {
        "paceSec": {"low": 2.2, "high": 1.4},
        "transitions": ["cut", "fade"],
        "captionStyle": "clean-sans-brand",
        "kenBurns": {"style": "minimal", "alternatePan": False},
        "color": {},
    },
}

BEATS_120 = synth_beat_grid(40.0)  # 0.5 s grid


def make_candidates(n: int = 14) -> list[Candidate]:
    import random as _random

    t0 = datetime(2026, 7, 15, 10, 0)
    rng = _random.Random(99)
    out = []
    for i in range(n):
        kind = "video" if i % 3 == 0 else "image"
        out.append(
            Candidate(
                id=f"asset{i:02d}",
                kind=kind,
                duration_sec=12.0 if kind == "video" else None,
                taken_at=t0 + timedelta(minutes=20 * i),
                quality=0.4 + (i % 7) * 0.08,
                tags=[{"label": "beach", "score": 0.3}] if i % 2 else [],
                faces_count=i % 4,
                face_area_ratio=0.05 * (i % 3),
                highlights=(
                    [
                        {"start": 1.0, "end": 3.5, "score": 0.9},
                        {"start": 5.0, "end": 8.0, "score": 0.7},
                        {"start": 9.0, "end": 11.0, "score": 0.5},
                    ]
                    if kind == "video"
                    else []
                ),
                # random 64-bit hashes: expected pairwise distance ~32, no accidental dupes
                phash=f"{rng.getrandbits(64):016x}",
            )
        )
    return out


def plan(
    vibe="travel-cinematic", seed=42, target=20.0, exclude=None, steering=None,
    cands=None, beats=None,
):
    return plan_autoedit(
        candidates=cands or make_candidates(),
        vibe_id=vibe,
        vibe_config=VIBES[vibe],
        aspect="9:16",
        width=1080,
        height=1920,
        target_sec=target,
        seed=seed,
        beat_times=BEATS_120 if beats is None else beats,
        energy=None,
        steering=steering,
        exclude_asset_ids=exclude,
        event_title="Jul 15",
        music_track_id="music1",
        music_duration=30.0,
    )


def jittered_beats(seed: int, duration: float = 40.0) -> list[float]:
    """A realistic librosa-like grid: ~0.5 s pulse with ±40 ms jitter."""
    import random as _random

    rng = _random.Random(seed)
    t, beats = 0.0, []
    while t < duration:
        beats.append(round(t, 3))
        t += 0.5 + rng.uniform(-0.04, 0.04)
    return beats


def video_clips(spec):
    return next(t for t in spec["tracks"] if t["type"] == "video")["clips"]


class TestDeterminism:
    @pytest.mark.parametrize("vibe", list(VIBES))
    def test_same_seed_identical_spec(self, vibe):
        a = plan(vibe=vibe, seed=7)
        b = plan(vibe=vibe, seed=7)
        assert json.dumps(a, sort_keys=True) == json.dumps(b, sort_keys=True)

    def test_different_seed_may_differ_but_valid(self):
        a = plan(seed=1)
        b = plan(seed=2)
        assert a["durationSec"] == b["durationSec"] == 20.0


class TestDuration:
    @pytest.mark.parametrize("target", [15.0, 20.0, 30.0, 45.0])
    def test_last_clip_ends_exactly_at_target(self, target):
        spec = plan(target=target)
        clips = video_clips(spec)
        last = clips[-1]
        assert last["timelineStart"] + last["duration"] == pytest.approx(target, abs=1e-6)

    def test_clips_contiguous_and_sorted(self):
        clips = video_clips(plan())
        pos = 0.0
        for clip in clips:
            assert clip["timelineStart"] == pytest.approx(pos, abs=1e-6)
            assert clip["duration"] >= MIN_SLOT_SEC - 1e-6
            pos += clip["duration"]


class TestBeatSync:
    @pytest.mark.parametrize("vibe", list(VIBES))
    @pytest.mark.parametrize("seed", [7, 42, 1234])
    def test_interior_cuts_on_beats(self, vibe, seed):
        """§6.5: every video-track cut within ±80 ms of a beat (except first/last)."""
        spec = plan(vibe=vibe, seed=seed)
        clips = video_clips(spec)
        beats = spec["meta"]["beatTimes"]
        for clip in clips[:-1]:
            cut = clip["timelineStart"] + clip["duration"]
            nearest = min(abs(cut - b) for b in beats)
            assert nearest <= BEAT_SNAP_TOLERANCE, f"cut at {cut} off-beat by {nearest}"

    @pytest.mark.parametrize("grid_seed", [3, 11])
    def test_interior_cuts_on_jittered_beats(self, grid_seed):
        """Real music never has a perfect 0.5 s grid — the property must hold on
        a jittered pulse too (last cut is the ±15% target-flex boundary)."""
        beats = jittered_beats(grid_seed)
        spec = plan(beats=beats)
        clips = video_clips(spec)
        for clip in clips[:-2]:
            cut = clip["timelineStart"] + clip["duration"]
            nearest = min(abs(cut - b) for b in beats)
            assert nearest <= BEAT_SNAP_TOLERANCE, f"cut at {cut} off-beat by {nearest}"

    def test_slot_plan_snaps_with_sparse_beats(self):
        slots = plan_slots(20.0, [1.0, 4.0, 9.0, 15.0, 19.5], None, 2.8, 1.6)
        assert slots[-1][1] == pytest.approx(20.0)
        for _, end in slots[:-1]:
            assert min(abs(end - b) for b in [1.0, 4.0, 9.0, 15.0, 19.5]) <= 1e-6


class TestShuffle:
    @pytest.mark.parametrize("seed_pair", [(42, 43), (7, 99), (1000, 1001)])
    def test_shuffle_at_least_40pct_different(self, seed_pair):
        first = plan(seed=seed_pair[0])
        prior_assets = [c["assetId"] for c in video_clips(first)]
        second = plan(seed=seed_pair[1], exclude=list(set(prior_assets)))
        new_assets = [c["assetId"] for c in video_clips(second)]
        n = len(new_assets)
        differing = sum(1 for asset_id in new_assets if asset_id not in set(prior_assets))
        assert differing / n >= 0.4, f"only {differing}/{n} assets differ after shuffle"


class TestDedupeAdjacency:
    def test_no_same_cluster_adjacent(self):
        import random as _random

        # 4 near-dupe groups around far-apart random bases (1-bit in-group variation)
        rng = _random.Random(5)
        bases = [rng.getrandbits(64) for _ in range(4)]
        cands = make_candidates()
        for i, c in enumerate(cands):
            c.phash = f"{bases[i // 4] ^ (1 << (i % 4)):016x}"
        group_of = {c.id: i // 4 for i, c in enumerate(cands)}
        spec = plan(cands=cands)
        clips = video_clips(spec)
        # cluster-level: adjacent clips must come from different NEAR-DUPE
        # groups, not merely be different assets (4 groups make it avoidable)
        for i in range(1, len(clips)):
            a, b = clips[i - 1]["assetId"], clips[i]["assetId"]
            assert group_of[a] != group_of[b], f"adjacent near-dupes {a},{b}"


class TestContent:
    def test_video_ratio_when_available(self):
        clips = video_clips(plan())
        kinds = [c["kind"] for c in clips]
        assert kinds.count("video") / len(kinds) >= 0.4 - 1e-6

    def test_video_clips_use_highlights(self):
        clips = video_clips(plan())
        vids = [c for c in clips if c["kind"] == "video"]
        assert vids
        for v in vids:
            assert "srcIn" in v and "srcOut" in v
            assert v["srcOut"] > v["srcIn"]
            span = (v["srcOut"] - v["srcIn"]) / v["speed"]
            assert span == pytest.approx(v["duration"], abs=0.06)

    def test_images_have_kenburns(self):
        clips = video_clips(plan())
        for c in clips:
            if c["kind"] == "image":
                assert "kenBurns" in c

    def test_title_card_from_event(self):
        spec = plan()
        texts = next(t for t in spec["tracks"] if t["type"] == "text")["clips"]
        assert texts and texts[0]["text"] == "Jul 15"

    def test_music_track_attached(self):
        spec = plan()
        audio = next(t for t in spec["tracks"] if t["type"] == "audio")["clips"]
        assert audio and audio[0]["assetId"] == "music1"

    def test_spec_passes_shared_zod_shape(self):
        """Minimal shape assertions mirroring the §5.1 contract."""
        spec = plan()
        assert spec["version"] == 1
        assert spec["aspect"] == "9:16"
        assert {t["type"] for t in spec["tracks"]} == {"video", "text", "audio"}
        assert spec["meta"]["seed"] == 42

    def test_quality_floor_filters(self):
        cands = make_candidates()
        bad = Candidate(id="terrible", kind="image", quality=0.05,
                        taken_at=datetime(2026, 7, 15, 9, 0))
        spec = plan(cands=[*cands, bad])
        assert all(c["assetId"] != "terrible" for c in video_clips(spec))
