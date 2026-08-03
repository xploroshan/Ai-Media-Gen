"""P5 — safety blocklist + StubProvider unit tests, and the gated live-fal smoke."""

import os
import shutil

import pytest

from worker.lib.safety import BlockedPromptError, check_prompt


class TestSafety:
    @pytest.mark.parametrize(
        "prompt",
        [
            "a nude child on the beach",
            "sexy teen girl in lingerie",
            "undressed photo of my ex",
            "deepfake porn of a celebrity",
            "naked minor",
        ],
    )
    def test_blocked(self, prompt):
        with pytest.raises(BlockedPromptError):
            check_prompt(prompt)

    @pytest.mark.parametrize(
        "prompt",
        [
            "a child playing on the beach at sunset",
            "nude color palette fashion shoot of a mannequin",
            "portrait of a teen athlete celebrating a goal",
            "a majestic naked mountain ridge at dawn",
            "product photo of baby shampoo bottle",
        ],
    )
    def test_allowed(self, prompt):
        check_prompt(prompt)  # must not raise


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not on PATH")
class TestStubProvider:
    @pytest.fixture(scope="class")
    def provider(self):
        from worker.lib.gen_provider import StubProvider

        return StubProvider(delay_sec=0.01)

    def test_t2i(self, provider):
        result = provider.generate("t2i", "any/slug", "a beach", {"aspect": "portrait"})
        assert result.status == "done"
        assert result.result_paths[0].suffix == ".png"
        from PIL import Image

        with Image.open(result.result_paths[0]) as img:
            assert img.size == (768, 1344)

    def test_t2v(self, provider):
        result = provider.generate("t2v", "any/slug", "waves", {"durationSec": 3})
        assert result.status == "done"
        assert result.result_paths[0].suffix == ".mp4"
        from worker.lib.ffmpeg import probe_summary

        probe = probe_summary(result.result_paths[0])
        assert probe["hasVideo"] and probe["hasAudio"]
        assert 2.5 <= (probe["durationSec"] or 0) <= 3.6

    def test_tts_and_music(self, provider):
        tts = provider.generate("tts", "s", "hello there friend", {})
        assert tts.status == "done" and tts.result_paths[0].suffix == ".mp3"
        music = provider.generate("music", "s", "upbeat", {"durationSec": 12})
        assert music.status == "done"
        from worker.lib.ffmpeg import probe_summary

        assert 11 <= (probe_summary(music.result_paths[0])["durationSec"] or 0) <= 13.5


@pytest.mark.skipif(
    os.environ.get("RUN_LIVE_AI") != "1" or not os.environ.get("FAL_KEY"),
    reason="live fal smoke only with RUN_LIVE_AI=1 and FAL_KEY (never in CI)",
)
def test_live_fal_t2i_smoke():
    """One real fal call (SPEC §10 P5). Requires RUN_LIVE_AI=1 + FAL_KEY."""
    from worker.lib.gen_provider import FalProvider

    provider = FalProvider(os.environ["FAL_KEY"])
    result = provider.generate("t2i", "fal-ai/flux/schnell", "a red bicycle, studio photo", {})
    assert result.status == "done", result.error
    assert result.result_paths and result.result_paths[0].stat().st_size > 10_000
