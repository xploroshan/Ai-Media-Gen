"""Speech-ducking helpers (SPEC §6.6.6) — pure, unit-tested."""

from __future__ import annotations

MERGE_GAP_SEC = 0.4
MIN_WINDOW_SEC = 0.15
MAX_WINDOWS = 40  # keep the ffmpeg enable-expression bounded


def speech_windows(
    words: list[dict], merge_gap: float = MERGE_GAP_SEC
) -> list[tuple[float, float]]:
    """Merge word timings [{w,s,e}] into contiguous speech windows."""
    spans = sorted((float(w["s"]), float(w["e"])) for w in words if w.get("e", 0) > w.get("s", 0))
    merged: list[tuple[float, float]] = []
    for start, end in spans:
        if merged and start - merged[-1][1] <= merge_gap:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))
    merged = [(s, e) for s, e in merged if e - s >= MIN_WINDOW_SEC]
    if len(merged) > MAX_WINDOWS:  # coalesce aggressively rather than overflow
        return speech_windows(
            [{"w": "", "s": s, "e": e} for s, e in merged], merge_gap=merge_gap * 2
        )
    return merged


def duck_volume_filter(windows: list[tuple[float, float]], duck_db: float) -> str | None:
    """`volume` filter that drops music by duck_db inside the speech windows."""
    if not windows or duck_db >= 0:
        return None
    enable = "+".join(f"between(t,{s:.3f},{e:.3f})" for s, e in windows)
    return f"volume=volume={duck_db:.1f}dB:enable='{enable}'"
