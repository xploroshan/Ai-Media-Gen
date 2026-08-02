"""P2 renderer tests — golden xfade offsets + a real ffmpeg render (SPEC §6.6)."""

import re
import shutil
import subprocess
import tempfile
from pathlib import Path

import pytest

from worker.lib.render import (
    OUTRO_SEC,
    build_plan,
    compute_clip_extensions,
    expected_output_duration,
    run_render,
    transition_of,
    verify_output,
)

HAS_FFMPEG = shutil.which("ffmpeg") is not None


def spec_3clips(watermark=False):
    return {
        "version": 1,
        "aspect": "9:16",
        "width": 1080,
        "height": 1920,
        "fps": 30,
        "durationSec": 6.0,
        "tracks": [
            {
                "id": "v1",
                "type": "video",
                "clips": [
                    {
                        "id": "c1", "assetId": "a", "kind": "image",
                        "timelineStart": 0.0, "duration": 2.0, "speed": 1.0,
                        "transform": {"scale": 1, "x": 0, "y": 0, "rotate": 0},
                        "kenBurns": {"fromScale": 1.0, "toScale": 1.1, "panX": 0.02, "panY": 0},
                        "transitionAfter": {"type": "fade", "duration": 0.3},
                    },
                    {
                        "id": "c2", "assetId": "b", "kind": "video",
                        "timelineStart": 2.0, "duration": 2.0,
                        "srcIn": 1.0, "srcOut": 3.0, "speed": 1.0,
                        "transform": {"scale": 1, "x": 0, "y": 0, "rotate": 0},
                        "transitionAfter": {"type": "cut", "duration": 0},
                    },
                    {
                        "id": "c3", "assetId": "a", "kind": "image",
                        "timelineStart": 4.0, "duration": 2.0, "speed": 1.0,
                        "transform": {"scale": 1, "x": 0, "y": 0, "rotate": 0},
                        "kenBurns": {"fromScale": 1.05, "toScale": 1.15, "panX": 0, "panY": 0},
                    },
                ],
            },
            {"id": "t1", "type": "text", "clips": []},
            {"id": "a1", "type": "audio", "clips": []},
        ],
        "captions": {"enabled": False, "styleId": "karaoke-yellow", "lang": "en", "words": []},
        "color": {"lut": None, "brightness": 0, "contrast": 0, "saturation": 0},
        "watermark": {"enabled": watermark},
        "meta": {"seed": 1, "beatTimes": []},
    }


def sources_for(spec, img: Path, vid: Path):
    return {"a": {"path": str(img), "duration": None}, "b": {"path": str(vid), "duration": 8.0}}


class TestOffsetGolden:
    def test_transition_of(self):
        fade_clip = {"transitionAfter": {"type": "fade", "duration": 0.3}}
        assert transition_of(fade_clip) == ("fade", 0.3)
        assert transition_of({"transitionAfter": {"type": "cut", "duration": 0}}) == ("cut", 0.0)
        assert transition_of({}) == ("cut", 0.0)

    def test_extensions_only_before_noncut(self):
        spec = spec_3clips()
        clips = spec["tracks"][0]["clips"]
        plans = compute_clip_extensions(
            clips, {"a": {"path": "x", "duration": None}, "b": {"path": "y", "duration": 8.0}}
        )
        assert plans[0].ext == pytest.approx(0.3)  # fade after c1
        assert plans[1].ext == 0.0  # cut after c2
        assert plans[2].ext == 0.0  # last clip
        assert plans[0].pad == 0.0  # image: no material limits

    def test_video_pad_when_material_exhausted(self):
        clips = [
            {
                "id": "c1", "assetId": "b", "kind": "video", "timelineStart": 0.0,
                "duration": 2.0, "srcIn": 6.5, "srcOut": 7.9, "speed": 1.0,
                "transitionAfter": {"type": "fade", "duration": 0.3},
            },
            {"id": "c2", "assetId": "b", "kind": "video", "timelineStart": 2.0,
             "duration": 1.0, "srcIn": 0.0, "srcOut": 1.0, "speed": 1.0},
        ]
        plans = compute_clip_extensions(clips, {"b": {"path": "y", "duration": 8.0}})
        # only 0.1 s of material after srcOut=7.9 → 0.2 s cloned pad
        assert plans[0].ext == pytest.approx(0.3)
        assert plans[0].pad == pytest.approx(0.2, abs=1e-6)

    def test_xfade_offset_equals_next_timeline_start(self):
        spec = spec_3clips()
        plan = build_plan(spec, sources_for(spec, Path("img.jpg"), Path("vid.mp4")), preview=True)
        pattern = r"xfade=transition=\w+:duration=[\d.]+:offset=([\d.]+)"
        offsets = [float(m) for m in re.findall(pattern, plan.filtergraph)]
        assert offsets == [pytest.approx(2.0)]  # single fade boundary at c2 start
        assert "concat=n=2:v=1:a=0" in plan.filtergraph  # the cut boundary

    def test_expected_duration_excludes_then_includes_outro(self):
        assert expected_output_duration(spec_3clips(False)) == pytest.approx(6.0)
        assert expected_output_duration(spec_3clips(True)) == pytest.approx(6.0 + OUTRO_SEC)

    def test_preview_canvas_is_540_short_side(self):
        spec = spec_3clips()
        plan = build_plan(spec, sources_for(spec, Path("i"), Path("v")), preview=True)
        assert min(plan.width, plan.height) == 540
        assert plan.width % 2 == 0 and plan.height % 2 == 0


@pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg not on PATH")
class TestRealRender:
    @pytest.fixture(scope="class")
    def media(self):
        tmp = Path(tempfile.mkdtemp(prefix="rf-render-test-"))
        img = tmp / "img.jpg"
        vid = tmp / "vid.mp4"
        subprocess.run(
            ["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i",
             "testsrc2=size=640x480:rate=30:duration=0.1", "-frames:v", "1", str(img)],
            check=True,
        )
        subprocess.run(
            ["ffmpeg", "-y", "-v", "error",
             "-f", "lavfi", "-i", "testsrc2=size=640x480:rate=30:duration=8",
             "-f", "lavfi", "-i", "sine=frequency=440:duration=8",
             "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", str(vid)],
            check=True,
        )
        yield {"img": img, "vid": vid, "tmp": tmp}
        shutil.rmtree(tmp, ignore_errors=True)

    def test_render_and_verify(self, media):
        spec = spec_3clips(watermark=False)
        plan = build_plan(spec, sources_for(spec, media["img"], media["vid"]), preview=True)
        out = media["tmp"] / "out.mp4"
        progress: list[int] = []
        run_render(plan, out, preview=True, on_progress=progress.append)
        snapshot = verify_output(out, plan)
        assert snapshot["duration"] == pytest.approx(6.0, abs=0.25)
        assert snapshot["videoCodec"] == "h264"
        assert snapshot["audioCodec"] == "aac"

    def test_render_with_watermark_outro(self, media):
        from worker.jobs.render import ensure_watermark

        spec = spec_3clips(watermark=True)
        plan = build_plan(
            spec,
            sources_for(spec, media["img"], media["vid"]),
            preview=True,
            watermark_png=ensure_watermark(),
        )
        out = media["tmp"] / "out-wm.mp4"
        run_render(plan, out, preview=True)
        snapshot = verify_output(out, plan)
        assert snapshot["duration"] == pytest.approx(6.0 + OUTRO_SEC, abs=0.25)

    def test_verify_rejects_wrong_duration(self, media):
        spec = spec_3clips(False)
        plan = build_plan(spec, sources_for(spec, media["img"], media["vid"]), preview=True)
        out = media["tmp"] / "short.mp4"
        subprocess.run(
            ["ffmpeg", "-y", "-v", "error",
             "-f", "lavfi", "-i", f"testsrc2=size={plan.width}x{plan.height}:rate=30:duration=2",
             "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
             "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", str(out)],
            check=True,
        )
        with pytest.raises(RuntimeError, match="duration"):
            verify_output(out, plan)
