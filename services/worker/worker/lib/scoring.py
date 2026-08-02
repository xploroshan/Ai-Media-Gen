"""Quality scoring — pure functions (SPEC §6.1.3, §6.1.4). Property-tested."""

from __future__ import annotations

import numpy as np

# blurVar normalization: variance of Laplacian ~0 (flat) .. ~1500+ (sharp photo)
BLUR_VAR_FULL_SCORE = 1000.0
# resolution: full score at >= 1920*1080 px
RESOLUTION_FULL_PIXELS = 1920 * 1080


def blur_var(gray: np.ndarray) -> float:
    """Variance of the Laplacian (sharpness proxy). gray: uint8 2-D array."""
    import cv2

    return float(cv2.Laplacian(gray, cv2.CV_64F).var())


def exposure_score(gray: np.ndarray, clip_threshold: float = 0.02) -> float:
    """1 − clipped-histogram fraction; >2% pixels at extremes penalized (SPEC §6.1.3)."""
    total = gray.size
    if total == 0:
        return 0.0
    dark = float(np.count_nonzero(gray <= 2)) / total
    bright = float(np.count_nonzero(gray >= 253)) / total
    clipped = dark + bright
    if clipped <= clip_threshold:
        return 1.0
    return float(max(0.0, 1.0 - (clipped - clip_threshold) / (1.0 - clip_threshold)))


def norm_blur(bv: float) -> float:
    return float(min(1.0, max(0.0, bv / BLUR_VAR_FULL_SCORE)))


def resolution_score(width: int | None, height: int | None) -> float:
    if not width or not height:
        return 0.0
    return float(min(1.0, (width * height) / RESOLUTION_FULL_PIXELS))


def quality_score(bv: float, exposure: float, res: float) -> float:
    """clamp(0.5*norm(blurVar) + 0.3*exposureScore + 0.2*resolutionScore)."""
    q = 0.5 * norm_blur(bv) + 0.3 * exposure + 0.2 * res
    return float(min(1.0, max(0.0, q)))


def top_windows(
    scores: np.ndarray,
    hop_sec: float,
    duration_sec: float,
    window_sec: float = 2.0,
    top_n: int = 5,
    min_window: float = 1.5,
    max_window: float = 4.0,
) -> list[dict]:
    """Top-N non-overlapping highlight windows by mean score (SPEC §6.1.4).

    scores: per-hop combined score (0.6*motion + 0.4*audioEnergy), hop = hop_sec.
    """
    window_sec = float(min(max(window_sec, min_window), max_window, max(duration_sec, min_window)))
    if len(scores) == 0 or duration_sec <= 0:
        return []
    win_hops = max(1, int(round(window_sec / hop_sec)))
    n = len(scores)
    window_means = [
        (float(np.mean(scores[i : i + win_hops])), i) for i in range(0, max(1, n - win_hops + 1))
    ]
    window_means.sort(key=lambda pair: (-pair[0], pair[1]))
    chosen: list[tuple[float, float, float]] = []
    for score, i in window_means:
        start = i * hop_sec
        end = min(duration_sec, start + window_sec)
        if any(start < c_end and end > c_start for c_start, c_end, _ in chosen):
            continue
        chosen.append((start, end, score))
        if len(chosen) >= top_n:
            break
    chosen.sort(key=lambda w: w[0])
    return [
        {"start": round(s, 3), "end": round(e, 3), "score": round(sc, 4)} for s, e, sc in chosen
    ]


def phash_hamming(hex_a: str, hex_b: str) -> int:
    """Hamming distance between two 64-bit hex perceptual hashes."""
    return bin(int(hex_a, 16) ^ int(hex_b, 16)).count("1")


def dedupe_clusters(hashes: dict[str, str], max_distance: int = 8) -> list[list[str]]:
    """Group asset ids whose phashes are within max_distance (SPEC §6.4.1).

    Simple union-find over pairwise distances (fine at library scale).
    """
    ids = [asset_id for asset_id, h in hashes.items() if h]
    parent = {i: i for i in ids}

    def find(x: str) -> str:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a: str, b: str) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra

    for i, a in enumerate(ids):
        for b in ids[i + 1 :]:
            if phash_hamming(hashes[a], hashes[b]) <= max_distance:
                union(a, b)

    groups: dict[str, list[str]] = {}
    for asset_id in ids:
        groups.setdefault(find(asset_id), []).append(asset_id)
    return sorted(groups.values(), key=lambda g: g[0])
