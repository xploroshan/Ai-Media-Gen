"""Edit-spec → FFmpeg render engine (SPEC §6.6).

Pure planning (input list + filtergraph + expected duration) is separated from
execution so offset math is golden-testable without running ffmpeg.

xfade consumes overlap, so every clip with a non-cut transitionAfter is rendered
with an extra tail equal to the transition duration (source material when
available, cloned last frame otherwise). Offsets then land exactly on the next
clip's timelineStart and the output duration equals the spec duration.
"""

from __future__ import annotations

import math
import subprocess
import threading
import time
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

OUTRO_SEC = 1.5  # appended branding card when watermark is on (§6.6.5)
RENDER_TIMEOUT_SEC = 1800  # hard cap; NFR §13 renders finish well inside this
XFADE_NAME = {"fade": "fade", "slideleft": "slideleft", "zoom": "zoomin"}


@dataclass
class ClipPlan:
    clip: dict
    source: Path
    ext: float = 0.0  # extra tail rendered for the following transition
    pad: float = 0.0  # part of ext with no source material -> cloned last frame


@dataclass
class RenderPlan:
    width: int
    height: int
    fps: float
    inputs: list[list[str]] = field(default_factory=list)  # per-input ffmpeg args
    filtergraph: str = ""
    expected_duration: float = 0.0
    map_video: str = "[vout]"
    map_audio: str = "[aout]"


def transition_of(clip: dict) -> tuple[str, float]:
    t = clip.get("transitionAfter") or {}
    t_type = t.get("type", "cut")
    dur = float(t.get("duration") or 0.0)
    if t_type == "cut" or dur <= 0.01:
        return "cut", 0.0
    return t_type, dur


def compute_clip_extensions(clips: list[dict], sources: dict[str, dict]) -> list[ClipPlan]:
    """Per-clip extension/pad for xfade overlap consumption. sources: assetId->{path,duration}.

    pad covers EVERY source-material shortfall — a transition tail past srcOut
    and a main body longer than the remaining source alike — by cloning the last
    frame, so the chain always emits exactly duration+ext seconds and the xfade
    offset math stays valid.
    """
    plans: list[ClipPlan] = []
    for i, clip in enumerate(clips):
        src = sources[clip["assetId"]]
        plan = ClipPlan(clip=clip, source=Path(src["path"]))
        if i < len(clips) - 1:
            t_type, t_dur = transition_of(clip)
            if t_type != "cut":
                plan.ext = t_dur
        if clip["kind"] == "video":
            speed = float(clip.get("speed", 1.0)) or 1.0
            src_in = float(clip.get("srcIn") or 0.0)
            src_dur = float(src.get("duration") or clip.get("srcOut") or 0.0)
            needed = float(clip["duration"]) + plan.ext  # output seconds
            available = max(0.0, (src_dur - src_in) / speed)
            plan.pad = min(needed, max(0.0, needed - available))
        plans.append(plan)
    return plans


def expected_output_duration(spec: dict) -> float:
    """Timeline duration + watermark outro. xfade math preserves the timeline exactly."""
    base = float(spec["durationSec"])
    if spec.get("watermark", {}).get("enabled"):
        base += OUTRO_SEC
    return base


def _video_chain(idx: int, plan: ClipPlan, w: int, h: int, fps: float) -> str:
    clip = plan.clip
    dur = float(clip["duration"])
    total = dur + plan.ext
    speed = float(clip.get("speed", 1.0)) or 1.0
    label = f"[v{idx}]"
    if clip["kind"] == "video":
        src_in = float(clip.get("srcIn") or 0.0)
        src_span = (dur + plan.ext - plan.pad) * speed
        src_end = src_in + src_span
        parts = [
            f"[{idx}:v]trim=start={src_in:.4f}:end={src_end:.4f}",
            "setpts=(PTS-STARTPTS)" + (f"/{speed:.4f}" if abs(speed - 1.0) > 1e-6 else ""),
            f"scale={w}:{h}:force_original_aspect_ratio=increase",
            f"crop={w}:{h}",
            f"fps={fps:g}",
            "setsar=1",
        ]
        if plan.pad > 0.001:
            parts.append(f"tpad=stop_mode=clone:stop_duration={plan.pad:.4f}")
        parts.append(f"trim=end={total:.4f}")
        parts.append("settb=AVTB")  # xfade requires identical timebases on both inputs
        return ",".join(parts) + label
    # image: kenBurns via zoompan (§6.6.1)
    kb = clip.get("kenBurns") or {"fromScale": 1.0, "toScale": 1.0, "panX": 0, "panY": 0}
    frames = max(1, int(round(total * fps)))
    zf, zt = float(kb.get("fromScale", 1.0)), float(kb.get("toScale", 1.0))
    px, py = float(kb.get("panX", 0.0)), float(kb.get("panY", 0.0))
    zoom_expr = f"{zf:.4f}+({zt - zf:.4f})*on/{frames}"
    x_expr = f"(iw-iw/zoom)/2+({px:.4f})*iw*on/{frames}"
    y_expr = f"(ih-ih/zoom)/2+({py:.4f})*ih*on/{frames}"
    # 1.5x supersample smooths zoompan stepping; 2x doubled memory/CPU for no
    # visible gain at 1080p output
    sw = int(w * 1.5) // 2 * 2
    sh = int(h * 1.5) // 2 * 2
    return (
        f"[{idx}:v]scale={sw}:{sh}:force_original_aspect_ratio=increase,"
        f"crop={sw}:{sh},"
        f"zoompan=z='{zoom_expr}':x='{x_expr}':y='{y_expr}':d={frames}:s={w}x{h}:fps={fps:g},"
        f"setsar=1,trim=end={total:.4f},settb=AVTB"
        + f"[v{idx}]"
    )


def build_plan(
    spec: dict,
    sources: dict[str, dict],
    preview: bool,
    ass_path: Path | None = None,
    watermark_png: Path | None = None,
    music: dict | None = None,  # {path, srcIn, gainDb}
    resolution: str | None = None,
) -> RenderPlan:
    """Build ffmpeg inputs + filtergraph from an edit-spec (§5.1)."""
    if preview:
        scale = 540 / min(spec["width"], spec["height"])
    elif resolution == "720p":
        scale = 720 / min(spec["width"], spec["height"])
    else:
        scale = 1080 / min(spec["width"], spec["height"])
    w = int(math.floor(spec["width"] * min(scale, 1.0) / 2) * 2)
    h = int(math.floor(spec["height"] * min(scale, 1.0) / 2) * 2)
    fps = float(spec.get("fps", 30))

    video_track = next(t for t in spec["tracks"] if t["type"] == "video")
    clips = video_track["clips"]
    if not clips:
        raise ValueError("no video clips to render")
    plans = compute_clip_extensions(clips, sources)

    rp = RenderPlan(width=w, height=h, fps=fps)
    graph: list[str] = []

    for i, plan in enumerate(plans):
        clip = plan.clip
        total = float(clip["duration"]) + plan.ext
        if clip["kind"] == "image":
            rp.inputs.append(["-loop", "1", "-t", f"{total + 0.5:.3f}", "-i", str(plan.source)])
        else:
            rp.inputs.append(["-i", str(plan.source)])
        graph.append(_video_chain(i, plan, w, h, fps))

    # transition chain: cut -> concat, else xfade at offset = next clip's timelineStart
    cur = "[v0]"
    cur_len = float(clips[0]["duration"]) + plans[0].ext
    for i in range(1, len(plans)):
        t_type, t_dur = transition_of(clips[i - 1])
        nxt = f"[v{i}]"
        out = f"[x{i}]"
        seg_len = float(clips[i]["duration"]) + plans[i].ext
        if t_type == "cut":
            graph.append(f"{cur}{nxt}concat=n=2:v=1:a=0,settb=AVTB{out}")
            cur_len = cur_len + seg_len
        else:
            offset = float(clips[i]["timelineStart"])
            graph.append(
                f"{cur}{nxt}xfade=transition={XFADE_NAME.get(t_type, 'fade')}:"
                f"duration={t_dur:.3f}:offset={offset:.4f},settb=AVTB{out}"
            )
            cur_len = offset + seg_len
        cur = out

    # color (§6.6.4)
    color = spec.get("color") or {}
    b = float(color.get("brightness", 0) or 0)
    c = float(color.get("contrast", 0) or 0)
    s = float(color.get("saturation", 0) or 0)
    if any(abs(v) > 1e-6 for v in (b, c, s)):
        graph.append(f"{cur}eq=brightness={b:.3f}:contrast={1 + c:.3f}:saturation={1 + s:.3f}[ceq]")
        cur = "[ceq]"

    # subtitles burn-in (§6.6.3)
    if ass_path is not None:
        escaped = str(ass_path).replace("\\", "/").replace(":", "\\:").replace("'", "\\'")
        graph.append(f"{cur}subtitles=filename='{escaped}'[subbed]")
        cur = "[subbed]"

    watermark_on = bool(spec.get("watermark", {}).get("enabled"))
    total_timeline = float(spec["durationSec"])
    expected = total_timeline + (OUTRO_SEC if watermark_on else 0.0)

    if watermark_on and watermark_png is not None:
        wm_idx = len(rp.inputs)
        rp.inputs.append(["-i", str(watermark_png)])
        wm_w = max(24, int(w * 0.06))
        graph.append(f"[{wm_idx}:v]scale={wm_w}:-1[wms]")
        graph.append(f"{cur}[wms]overlay=W-w-16:H-h-16[wmd]")
        cur = "[wmd]"
        # 1.5 s outro card
        graph.append(
            f"color=c=0x0b0b0f:s={w}x{h}:r={fps:g}:d={OUTRO_SEC},"
            f"drawtext=text='Made with ReelForge':fontcolor=white:fontsize={int(h * 0.045)}:"
            f"x=(w-text_w)/2:y=(h-text_h)/2,setsar=1,settb=AVTB[outro]"
        )
        graph.append(f"{cur}[outro]concat=n=2:v=1:a=0[vfin]")
        cur = "[vfin]"

    graph.append(f"{cur}format=yuv420p[vout]")

    # audio (§6.6.6): music trimmed/looped to duration, ducked under speech,
    # mixed with speech-bearing clip audio, master loudnorm
    speech = spec.get("_speech") or {}  # {windows: [(s,e)], clipAudio: [{inputArgs, filter}]}
    music_label = None
    if music is not None:
        a_idx = len(rp.inputs)
        rp.inputs.append(
            ["-stream_loop", "-1", "-ss", f"{float(music.get('srcIn', 0.0)):.3f}", "-i",
             str(music["path"])]
        )
        gain = float(music.get("gainDb", 0.0))
        chain = [
            f"[{a_idx}:a]atrim=0:{total_timeline:.4f}",
            "asetpts=PTS-STARTPTS",
            f"volume={gain:.1f}dB",
        ]
        from worker.lib.ducking import duck_volume_filter

        duck = duck_volume_filter(
            speech.get("windows") or [], float(music.get("duckUnderSpeechDb", -10.0))
        )
        if duck:
            chain.append(duck)
        graph.append(",".join(chain) + "[amusic]")
        music_label = "[amusic]"

    speech_labels: list[str] = []
    for spec_clip in speech.get("clips") or []:
        # clip source audio aligned to the timeline (only speech-bearing clips)
        a_idx = len(rp.inputs)
        rp.inputs.append(["-i", str(spec_clip["path"])])
        src_in = float(spec_clip["srcIn"])
        src_out = float(spec_clip["srcOut"])
        speed = float(spec_clip.get("speed", 1.0)) or 1.0
        delay_ms = int(float(spec_clip["timelineStart"]) * 1000)
        chain = [
            f"[{a_idx}:a]atrim=start={src_in:.3f}:end={src_out:.3f}",
            "asetpts=PTS-STARTPTS",
        ]
        if abs(speed - 1.0) > 1e-6 and 0.5 <= speed <= 2.0:
            chain.append(f"atempo={speed:.4f}")
        chain.append(f"adelay={delay_ms}|{delay_ms}")
        label = f"[aspeech{len(speech_labels)}]"
        graph.append(",".join(chain) + label)
        speech_labels.append(label)

    mix_inputs = ([music_label] if music_label else []) + speech_labels
    if mix_inputs:
        if len(mix_inputs) == 1:
            mixed = mix_inputs[0]
        else:
            graph.append(
                "".join(mix_inputs)
                + f"amix=inputs={len(mix_inputs)}:duration=longest:normalize=0[amixed]"
            )
            mixed = "[amixed]"
        graph.append(
            f"{mixed}apad=pad_dur={OUTRO_SEC if watermark_on else 0.01},"
            f"atrim=0:{expected:.4f},"
            "loudnorm=I=-14:TP=-1.5[aout]"
        )
    else:
        graph.append(
            f"anullsrc=channel_layout=stereo:sample_rate=44100,atrim=0:{expected:.4f}[aout]"
        )

    rp.filtergraph = ";".join(graph)
    rp.expected_duration = expected
    return rp


def encode_args(preview: bool) -> list[str]:
    if preview:
        return ["-c:v", "libx264", "-preset", "veryfast", "-crf", "28",
                "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart"]
    return ["-c:v", "libx264", "-preset", "medium", "-crf", "20",
            "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"]


def run_render(
    plan: RenderPlan,
    out_path: Path,
    preview: bool,
    on_progress: Callable[[int], None] | None = None,
) -> None:
    cmd = ["ffmpeg", "-y", "-v", "error"]
    for input_args in plan.inputs:
        cmd += input_args
    cmd += [
        "-filter_complex", plan.filtergraph,
        "-map", plan.map_video, "-map", plan.map_audio,
        "-t", f"{plan.expected_duration + 0.05:.3f}",
        "-r", f"{plan.fps:g}",
        *encode_args(preview),
        "-progress", "pipe:1",
        str(out_path),
    ]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)

    # stderr must be drained concurrently or ffmpeg deadlocks once the pipe
    # buffer fills; keep only a bounded tail for error reporting
    stderr_tail: deque[str] = deque(maxlen=100)

    def _drain_stderr() -> None:
        assert proc.stderr is not None
        for err_line in proc.stderr:
            stderr_tail.append(err_line)

    drain = threading.Thread(target=_drain_stderr, daemon=True)
    drain.start()

    timed_out = threading.Event()

    def _watchdog_fire() -> None:
        timed_out.set()
        proc.kill()

    watchdog = threading.Timer(RENDER_TIMEOUT_SEC, _watchdog_fire)
    watchdog.start()

    last_emit = 0.0
    try:
        assert proc.stdout is not None
        for line in proc.stdout:
            if line.startswith("out_time_ms=") and on_progress:
                try:
                    out_sec = int(line.split("=", 1)[1]) / 1_000_000
                except ValueError:
                    continue
                now = time.monotonic()
                if now - last_emit >= 2.0:  # §6.6.8: update every 2 s
                    pct = int(min(99, max(0, out_sec / plan.expected_duration * 100)))
                    on_progress(pct)
                    last_emit = now
        proc.wait()
    finally:
        watchdog.cancel()
        if proc.poll() is None:
            proc.kill()
            proc.wait()
        drain.join(timeout=5)

    if timed_out.is_set():
        raise RuntimeError(f"ffmpeg render timed out after {RENDER_TIMEOUT_SEC} s")
    if proc.returncode != 0:
        err = "".join(stderr_tail)
        raise RuntimeError(f"ffmpeg render failed ({proc.returncode}): {err[-800:]}")


def verify_output(out_path: Path, plan: RenderPlan) -> dict[str, Any]:
    """ffprobe verification (§6.6.7): duration ±0.25 s, WxH, v+a streams."""
    from worker.lib.ffmpeg import ffprobe

    data = ffprobe(out_path)
    fmt = data.get("format", {})
    duration = float(fmt.get("duration", 0) or 0)
    streams = data.get("streams", [])
    v = next((s for s in streams if s.get("codec_type") == "video"), None)
    a = next((s for s in streams if s.get("codec_type") == "audio"), None)
    snapshot = {
        "duration": duration,
        "expected": plan.expected_duration,
        "width": v.get("width") if v else None,
        "height": v.get("height") if v else None,
        "videoCodec": v.get("codec_name") if v else None,
        "audioCodec": a.get("codec_name") if a else None,
        "bytes": int(fmt.get("size", 0) or 0),
    }
    problems = []
    if abs(duration - plan.expected_duration) > 0.25:
        problems.append(f"duration {duration:.2f} != expected {plan.expected_duration:.2f}")
    if not v or v.get("width") != plan.width or v.get("height") != plan.height:
        problems.append(
            f"dims {snapshot['width']}x{snapshot['height']} != {plan.width}x{plan.height}"
        )
    if not a:
        problems.append("missing audio stream")
    if problems:
        raise RuntimeError("render verification failed: " + "; ".join(problems))
    return snapshot
