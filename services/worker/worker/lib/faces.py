"""MediaPipe face *detection* (count + area only — NO identity/recognition, SPEC §6.1.6).

Uses the MediaPipe Tasks API (legacy `solutions` was removed in mediapipe >=0.10.2x).
The BlazeFace short-range model (~230 KB, Apache-2.0) is fetched once into
MODEL_CACHE_DIR (baked into the Docker image at build time).
"""

from __future__ import annotations

import threading
import urllib.request
from pathlib import Path

from worker.lib.settings import get_settings

MODEL_URL = (
    "https://storage.googleapis.com/mediapipe-models/face_detector/"
    "blaze_face_short_range/float16/1/blaze_face_short_range.tflite"
)

_lock = threading.Lock()
_detector = None


def model_path() -> Path:
    return Path(get_settings().model_cache_dir) / "blaze_face_short_range.tflite"


def ensure_model() -> Path:
    path = model_path()
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        urllib.request.urlretrieve(MODEL_URL, tmp)  # noqa: S310 - fixed https URL
        tmp.rename(path)
    return path


def _get_detector():
    global _detector
    with _lock:
        if _detector is None:
            from mediapipe.tasks.python.core.base_options import BaseOptions
            from mediapipe.tasks.python.vision.face_detector import (
                FaceDetector,
                FaceDetectorOptions,
            )

            options = FaceDetectorOptions(
                base_options=BaseOptions(model_asset_path=str(ensure_model())),
                min_detection_confidence=0.5,
            )
            _detector = FaceDetector.create_from_options(options)
    return _detector


def detect_faces(image_path: Path | str) -> tuple[int, float]:
    """Returns (facesCount, faceAreaRatio 0..1) on the given image."""
    import mediapipe as mp

    image = mp.Image.create_from_file(str(image_path))
    result = _get_detector().detect(image)
    if not result.detections:
        return 0, 0.0
    img_area = float(image.width * image.height) or 1.0
    area = 0.0
    for det in result.detections:
        box = det.bounding_box
        area += max(0, box.width) * max(0, box.height)
    return len(result.detections), float(min(1.0, area / img_area))
