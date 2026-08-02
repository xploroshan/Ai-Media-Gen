"""GenProvider abstraction — SPEC §8.1.

FalProvider: fal.ai queue API via httpx, 3 s poll, 10 min timeout.
StubProvider: local fixture assets after ~2 s — DEFAULT when FAL_KEY is unset.
CI always runs the stub; no external AI calls ever happen without FAL_KEY.
"""

from __future__ import annotations

import json
import math
import subprocess
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path

from worker.lib.settings import get_settings

POLL_INTERVAL_SEC = 3.0
TIMEOUT_SEC = 600.0


@dataclass
class GenResult:
    status: str  # queued|running|done|failed
    result_paths: list[Path] = field(default_factory=list)  # local files when done
    cost_usd: float | None = None
    error: str | None = None


class StubProvider:
    """Deterministic local fixtures after a ~2 s delay (SPEC §8.1)."""

    provider_id = "stub"

    def __init__(self, delay_sec: float = 2.0):
        self.delay_sec = delay_sec

    def generate(self, kind: str, model_slug: str, prompt: str, params: dict) -> GenResult:
        time.sleep(self.delay_sec)
        tmp = Path(tempfile.mkdtemp(prefix="stub-gen-"))
        try:
            if kind == "t2i":
                paths = [self._image(tmp, prompt, params)]
            elif kind in ("i2v", "t2v"):
                paths = [self._video(tmp, prompt, params)]
            elif kind == "tts":
                paths = [self._tts(tmp, prompt, params)]
            elif kind == "music":
                paths = [self._music(tmp, prompt, params)]
            else:
                return GenResult(status="failed", error=f"unknown kind {kind}")
        except Exception as exc:  # pragma: no cover - stub failures are bugs
            return GenResult(status="failed", error=str(exc))
        return GenResult(status="done", result_paths=paths, cost_usd=0.0)

    def _image(self, tmp: Path, prompt: str, params: dict) -> Path:
        from PIL import Image, ImageDraw

        seed = abs(hash(prompt)) % 360
        w, h = {"square": (1024, 1024), "portrait": (768, 1344), "landscape": (1344, 768)}.get(
            params.get("aspect", "square"), (1024, 1024)
        )
        img = Image.new("RGB", (w, h))
        px = img.load()
        for y in range(0, h, 2):
            for x in range(0, w, 2):
                r = int(128 + 127 * math.sin((x + seed * 3) / 97))
                g = int(128 + 127 * math.sin((y + seed * 7) / 71))
                b = int(128 + 127 * math.sin((x + y + seed) / 53))
                for dx in (0, 1):
                    for dy in (0, 1):
                        if x + dx < w and y + dy < h:
                            px[x + dx, y + dy] = (r, g, b)
        draw = ImageDraw.Draw(img)
        draw.rectangle((20, h - 90, w - 20, h - 30), fill=(10, 10, 14))
        draw.text((32, h - 78), f"[stub] {prompt[:60]}", fill=(240, 240, 250))
        out = tmp / "result.png"
        img.save(out)
        return out

    def _video(self, tmp: Path, prompt: str, params: dict) -> Path:
        duration = min(8, max(3, int(params.get("durationSec", 5))))
        out = tmp / "result.mp4"
        text = prompt[:40].replace("'", "").replace(":", "").replace("\\", "")
        subprocess.run(
            [
                "ffmpeg", "-y", "-v", "error",
                "-f", "lavfi", "-i", f"testsrc2=size=720x1280:rate=24:duration={duration}",
                "-f", "lavfi", "-i", f"sine=frequency=330:duration={duration}",
                "-vf", f"drawtext=text='[stub] {text}':fontcolor=white:fontsize=28:x=20:y=40",
                "-c:v", "libx264", "-preset", "veryfast", "-crf", "26",
                "-c:a", "aac", "-shortest", str(out),
            ],
            check=True,
        )
        return out

    def _tts(self, tmp: Path, prompt: str, params: dict) -> Path:
        duration = max(1.0, min(30.0, len(prompt) / 15))
        out = tmp / "voice.mp3"
        subprocess.run(
            [
                "ffmpeg", "-y", "-v", "error",
                "-f", "lavfi",
                "-i",
                f"aevalsrc=0.35*sin(2*PI*170*t)*(0.55+0.45*sin(2*PI*2.6*t)):s=22050:d={duration:.1f}",
                "-c:a", "libmp3lame", "-q:a", "5", str(out),
            ],
            check=True,
        )
        return out

    def _music(self, tmp: Path, prompt: str, params: dict) -> Path:
        duration = min(60, max(10, int(params.get("durationSec", 30))))
        out = tmp / "music.mp3"
        beat = (
            "sin(2*PI*880*t)*lt(mod(t\\,0.5)\\,0.06)"
            "+0.3*sin(2*PI*220*t)*lt(mod(t\\,0.5)\\,0.12)"
            "+0.2*sin(2*PI*440*t)*lt(mod(t+0.25\\,0.5)\\,0.05)"
        )
        subprocess.run(
            [
                "ffmpeg", "-y", "-v", "error",
                "-f", "lavfi", "-i", f"aevalsrc={beat}:s=44100:d={duration}",
                "-c:a", "libmp3lame", "-q:a", "4", str(out),
            ],
            check=True,
        )
        return out


class FalProvider:
    """fal.ai queue API (SPEC §8.1): submit → poll every 3 s → download, 10 min cap."""

    provider_id = "fal"

    def __init__(self, api_key: str):
        self.api_key = api_key

    def generate(self, kind: str, model_slug: str, prompt: str, params: dict) -> GenResult:
        import httpx

        headers = {"Authorization": f"Key {self.api_key}"}
        payload = self._payload(kind, prompt, params)
        with httpx.Client(timeout=30.0) as client:
            submit = client.post(
                f"https://queue.fal.run/{model_slug}", headers=headers, json=payload
            )
            if submit.status_code >= 400:
                return GenResult(
                    status="failed",
                    error=f"fal submit failed ({submit.status_code}): {submit.text[:300]}",
                )
            info = submit.json()
            status_url = info.get("status_url")
            response_url = info.get("response_url")
            if not status_url or not response_url:
                return GenResult(status="failed", error="fal response missing queue urls")

            deadline = time.monotonic() + TIMEOUT_SEC
            while time.monotonic() < deadline:
                status = client.get(status_url, headers=headers).json()
                state = status.get("status")
                if state == "COMPLETED":
                    result = client.get(response_url, headers=headers).json()
                    return self._download(client, headers, result)
                if state in ("FAILED", "CANCELLED"):
                    return GenResult(status="failed", error=json.dumps(status)[:400])
                time.sleep(POLL_INTERVAL_SEC)
        return GenResult(status="failed", error="fal generation timed out (10 min)")

    def _payload(self, kind: str, prompt: str, params: dict) -> dict:
        body: dict = {"prompt": prompt}
        if kind in ("i2v",) and params.get("imageUrl"):
            body["image_url"] = params["imageUrl"]
        if kind in ("i2v", "t2v") and params.get("durationSec"):
            body["duration"] = params["durationSec"]
        if kind == "tts":
            body = {"text": prompt, **({"voice": params["voice"]} if params.get("voice") else {})}
        if kind == "music" and params.get("durationSec"):
            body["duration_seconds"] = params["durationSec"]
        return body

    def _download(self, client, headers, result: dict) -> GenResult:
        urls: list[str] = []

        def walk(node):
            if isinstance(node, dict):
                if isinstance(node.get("url"), str):
                    urls.append(node["url"])
                for value in node.values():
                    walk(value)
            elif isinstance(node, list):
                for value in node:
                    walk(value)

        walk(result)
        if not urls:
            return GenResult(status="failed", error="fal result contained no file urls")
        tmp = Path(tempfile.mkdtemp(prefix="fal-gen-"))
        paths = []
        for i, url in enumerate(urls[:4]):
            suffix = Path(url.split("?")[0]).suffix or ".bin"
            path = tmp / f"result-{i}{suffix}"
            with client.stream("GET", url, headers=headers, timeout=120.0) as resp:
                resp.raise_for_status()
                with open(path, "wb") as fh:
                    for chunk in resp.iter_bytes():
                        fh.write(chunk)
            paths.append(path)
        return GenResult(status="done", result_paths=paths)


def get_provider():
    settings = get_settings()
    if settings.fal_key:
        return FalProvider(settings.fal_key)
    return StubProvider()
