"""P1 exit tests: quality-scoring monotonicity + phash dedupe (SPEC §10 P1)."""

import numpy as np
import pytest

from worker.lib import scoring

cv2 = pytest.importorskip("cv2")


def _noisy_image(sigma: float, seed: int = 7) -> np.ndarray:
    """Base pattern blurred by sigma — higher sigma = blurrier."""
    rng = np.random.default_rng(seed)
    img = (rng.random((256, 256)) * 255).astype(np.uint8)
    if sigma > 0:
        img = cv2.GaussianBlur(img, (0, 0), sigma)
    return img


class TestQualityMonotonicity:
    def test_blur_var_decreases_with_blur(self):
        # variance bottoms out into sensor-noise floor past sigma~4; assert over useful range
        variances = [scoring.blur_var(_noisy_image(sigma)) for sigma in (0, 1, 2, 4)]
        assert variances == sorted(variances, reverse=True)

    def test_quality_score_monotonic_in_sharpness(self):
        scores = [
            scoring.quality_score(scoring.blur_var(_noisy_image(sigma)), 1.0, 1.0)
            for sigma in (0, 2, 8)
        ]
        assert scores[0] > scores[1] > scores[2]

    def test_exposure_penalizes_clipping(self):
        good = np.full((100, 100), 128, dtype=np.uint8)
        blown = np.full((100, 100), 255, dtype=np.uint8)
        half_blown = good.copy()
        half_blown[:50] = 255
        assert scoring.exposure_score(good) == 1.0
        assert scoring.exposure_score(blown) == pytest.approx(0.0, abs=1e-6)
        mid = scoring.exposure_score(half_blown)
        assert 0.0 < mid < 1.0

    def test_resolution_monotonic(self):
        assert (
            scoring.resolution_score(640, 360)
            < scoring.resolution_score(1280, 720)
            < scoring.resolution_score(1920, 1080)
        )
        assert scoring.resolution_score(3840, 2160) == 1.0

    def test_quality_bounds(self):
        assert 0.0 <= scoring.quality_score(0, 0, 0) <= 1.0
        assert scoring.quality_score(1e9, 1.0, 1.0) == 1.0


class TestPhashDedupe:
    def test_hamming(self):
        assert scoring.phash_hamming("0" * 16, "0" * 16) == 0
        assert scoring.phash_hamming("0" * 16, "f" + "0" * 15) == 4
        assert scoring.phash_hamming("ffffffffffffffff", "0000000000000000") == 64

    def test_near_dupes_cluster_together(self):
        base = 0x8F3A_5C71_D2E4_9B06
        hashes = {
            "a": f"{base:016x}",
            "b": f"{base ^ 0b111:016x}",  # distance 3 -> same cluster
            "c": f"{base ^ ((1 << 63) | (1 << 42) | (1 << 21) | 0x3FF):016x}",  # far
            "d": f"{(~base) & 0xFFFFFFFFFFFFFFFF:016x}",  # inverse, very far
        }
        clusters = scoring.dedupe_clusters(hashes, max_distance=8)
        cluster_of = {aid: i for i, cl in enumerate(clusters) for aid in cl}
        assert cluster_of["a"] == cluster_of["b"]
        assert cluster_of["a"] != cluster_of["c"]
        assert cluster_of["a"] != cluster_of["d"]

    def test_real_phash_of_similar_images(self):
        imagehash = pytest.importorskip("imagehash")
        from PIL import Image

        rng = np.random.default_rng(3)
        base = (rng.random((64, 64, 3)) * 255).astype(np.uint8)
        # Structured image so phash is stable: gradient + noise
        gradient = np.linspace(0, 255, 64, dtype=np.uint8)[None, :, None]
        img_a = ((base * 0.25) + (gradient * 0.75)).astype(np.uint8)
        img_b = img_a.copy()
        img_b[:2, :2] = 0  # tiny edit -> near-dupe
        h_a = str(imagehash.phash(Image.fromarray(img_a)))
        h_b = str(imagehash.phash(Image.fromarray(img_b)))
        assert scoring.phash_hamming(h_a, h_b) <= 8


class TestTopWindows:
    def test_non_overlapping_and_sorted(self):
        scores = np.zeros(60)
        scores[10:14] = 1.0  # 5-7 s
        scores[30:34] = 0.9  # 15-17 s
        scores[50:54] = 0.8  # 25-27 s
        wins = scoring.top_windows(scores, 0.5, 30.0, window_sec=2.0, top_n=5)
        assert 1 <= len(wins) <= 5
        for i in range(1, len(wins)):
            assert wins[i]["start"] >= wins[i - 1]["end"]
        starts = [w["start"] for w in wins]
        assert starts == sorted(starts)

    def test_empty(self):
        assert scoring.top_windows(np.array([]), 0.5, 0.0) == []

    def test_window_bounds(self):
        wins = scoring.top_windows(np.ones(20), 0.5, 10.0, window_sec=2.0, top_n=5)
        for w in wins:
            assert 0 <= w["start"] < w["end"] <= 10.0
            assert 1.5 <= w["end"] - w["start"] <= 4.0 + 1e-9
