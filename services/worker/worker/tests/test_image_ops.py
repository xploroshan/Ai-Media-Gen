"""P6 exit tests — mask plumbing + enhance (pure parts of SPEC §6.7)."""

import numpy as np
import pytest

cv2 = pytest.importorskip("cv2")

from worker.lib.image_ops_lib import enhance, prepare_mask  # noqa: E402


class TestMaskPlumbing:
    def test_rgba_alpha_becomes_mask_and_resizes(self):
        mask = np.zeros((100, 100, 4), dtype=np.uint8)
        mask[20:60, 30:70, 3] = 255  # strokes live in alpha
        out = prepare_mask(mask, (200, 200))
        assert out.shape == (200, 200)
        assert set(np.unique(out)) <= {0, 255}
        assert out[80, 100] == 255  # inside scaled stroke
        assert out[10, 10] == 0

    def test_rgb_mask_converts_via_luma(self):
        mask = np.zeros((50, 50, 3), dtype=np.uint8)
        mask[10:20, 10:20] = 255
        out = prepare_mask(mask, (50, 50))
        assert out[15, 15] == 255
        assert out[40, 40] == 0

    def test_gray_mask_binarizes_at_127(self):
        mask = np.full((10, 10), 100, dtype=np.uint8)
        mask[0, 0] = 200
        out = prepare_mask(mask, (10, 10))
        assert out[0, 0] == 255
        assert out[5, 5] == 0

    def test_opaque_rgba_alpha_wins_and_erases_everything(self):
        # canvas exported with full alpha but white strokes on black: by
        # contract alpha wins whenever it carries ANY signal (max>0), so a
        # uniformly-opaque alpha means the whole frame is marked for erase.
        # Callers exporting opaque canvases must send RGB/gray masks instead.
        mask = np.zeros((40, 40, 4), dtype=np.uint8)
        mask[..., 3] = 255
        mask[5:15, 5:15, :3] = 255
        out = prepare_mask(mask, (40, 40))
        assert out.shape == (40, 40)
        assert (out == 255).all()

    def test_nearest_resize_keeps_edges_binary(self):
        mask = np.zeros((10, 10), dtype=np.uint8)
        mask[4:6, 4:6] = 255
        out = prepare_mask(mask, (37, 41))
        assert set(np.unique(out)) <= {0, 255}


class TestEnhance:
    def _sample(self):
        rng = np.random.default_rng(11)
        img = (rng.random((120, 160, 3)) * 120).astype(np.uint8)  # dark-ish
        img[..., 0] = np.clip(img[..., 0].astype(int) + 40, 0, 255)  # blue cast
        return img

    def test_output_shape_dtype(self):
        img = self._sample()
        out = enhance(img)
        assert out.shape == img.shape
        assert out.dtype == np.uint8

    def test_contrast_improves(self):
        img = self._sample()
        out = enhance(img)
        gray_in = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        gray_out = cv2.cvtColor(out, cv2.COLOR_BGR2GRAY)
        assert gray_out.std() > gray_in.std()  # CLAHE spreads the histogram

    def test_white_balance_reduces_channel_skew(self):
        img = self._sample()
        out = enhance(img)
        means_in = img.reshape(-1, 3).mean(axis=0)
        means_out = out.reshape(-1, 3).mean(axis=0)
        assert means_out.std() < means_in.std()  # channels closer together

    def test_pure_no_mutation(self):
        img = self._sample()
        copy = img.copy()
        enhance(img)
        assert np.array_equal(img, copy)
