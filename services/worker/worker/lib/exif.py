"""EXIF extraction via Pillow: takenAt + GPS (SPEC §6.1.1)."""

from __future__ import annotations

import contextlib
from datetime import datetime
from pathlib import Path


def _to_deg(values, ref: str) -> float | None:
    try:
        d, m, s = (float(v) for v in values)
        deg = d + m / 60.0 + s / 3600.0
        if ref in ("S", "W"):
            deg = -deg
        return deg
    except (TypeError, ValueError, ZeroDivisionError):
        return None


def read_exif(image_path: Path | str) -> dict:
    """Returns {takenAt: datetime|None, gpsLat: float|None, gpsLng: float|None}."""
    from PIL import ExifTags, Image

    out: dict = {"takenAt": None, "gpsLat": None, "gpsLng": None}
    try:
        with Image.open(image_path) as img:
            exif = img.getexif()
            if not exif:
                return out
            # DateTimeOriginal lives in the Exif IFD
            ifd = exif.get_ifd(ExifTags.IFD.Exif)
            dt = ifd.get(ExifTags.Base.DateTimeOriginal) or exif.get(ExifTags.Base.DateTime)
            if dt:
                with contextlib.suppress(ValueError):
                    out["takenAt"] = datetime.strptime(str(dt), "%Y:%m:%d %H:%M:%S")
            gps = exif.get_ifd(ExifTags.IFD.GPSInfo)
            if gps:
                lat = _to_deg(gps.get(2), str(gps.get(1, "N")))
                lng = _to_deg(gps.get(4), str(gps.get(3, "E")))
                out["gpsLat"], out["gpsLng"] = lat, lng
    except Exception:
        pass  # EXIF is best-effort; absence is normal
    return out
