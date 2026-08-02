#!/usr/bin/env python3
"""Generate deterministic synthetic image fixtures with EXIF (Pillow only).

Called by make_fixtures.sh. No binary fixtures live in git (SPEC §2).
"""

from __future__ import annotations

import math
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

OUT = Path(sys.argv[1] if len(sys.argv) > 1 else "e2e/fixtures")

# Goa, IN — clusters within 25 km for event detection
GPS = (15.30, 74.12)
DAY = "2026:07:15"


def exif_bytes(dt: str, gps: tuple[float, float] | None) -> bytes:
    exif = Image.Exif()
    from PIL.ExifTags import IFD, Base, GPS as GPSTags

    exif[Base.DateTime] = dt
    exif.get_ifd(IFD.Exif)[Base.DateTimeOriginal] = dt
    if gps:
        lat, lng = gps

        def dms(value: float):
            value = abs(value)
            d = int(value)
            m = int((value - d) * 60)
            s = round(((value - d) * 60 - m) * 60 * 100) / 100
            return (d, m, s)

        gps_ifd = exif.get_ifd(IFD.GPSInfo)
        gps_ifd[GPSTags.GPSLatitudeRef] = "N" if lat >= 0 else "S"
        gps_ifd[GPSTags.GPSLatitude] = dms(lat)
        gps_ifd[GPSTags.GPSLongitudeRef] = "E" if lng >= 0 else "W"
        gps_ifd[GPSTags.GPSLongitude] = dms(lng)
    return exif.tobytes()


def base_scene(seed_hue: int) -> Image.Image:
    """Colorful structured scene: gradient sky + 'sun' + ridges — sharp features."""
    w, h = 1280, 960
    img = Image.new("RGB", (w, h))
    px = img.load()
    for y in range(h):
        for x in range(0, w, 4):
            r = int(120 + 100 * math.sin((x / w) * 3 + seed_hue))
            g = int(80 + 80 * (y / h))
            b = int(180 - 120 * (y / h))
            for dx in range(4):
                if x + dx < w:
                    px[x + dx, y] = (max(0, min(255, r)), max(0, min(255, g)), max(0, min(255, b)))
    draw = ImageDraw.Draw(img)
    draw.ellipse((w * 0.62, h * 0.12, w * 0.80, h * 0.36), fill=(255, 210, 90))
    for i in range(7):
        x0 = int(w * 0.02 + i * w * 0.14)
        draw.polygon(
            [(x0, h), (x0 + int(w * 0.10), int(h * 0.55) + (i % 3) * 40), (x0 + int(w * 0.20), h)],
            fill=(30 + i * 10, 60 + i * 8, 40 + i * 6),
        )
    for i in range(60):  # texture for sharpness
        x = (i * 97) % w
        y = int(h * 0.6) + (i * 53) % int(h * 0.4)
        draw.rectangle((x, y, x + 6, y + 6), fill=(255 - i * 3 % 200, i * 5 % 255, 90))
    return img


def save(img: Image.Image, name: str, hour: int, minute: int, quality: int = 92) -> None:
    dt = f"{DAY} {hour:02d}:{minute:02d}:00"
    img.save(OUT / name, "JPEG", quality=quality, exif=exif_bytes(dt, GPS))
    print(f"  {name} ({dt})")


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    img1 = base_scene(0)
    save(img1, "img1.jpg", 10, 0)

    img2 = img1.copy()  # near-dupe: tiny crop shift
    img2 = img2.crop((8, 8, img2.width, img2.height)).resize(img1.size)
    save(img2, "img2.jpg", 10, 5)

    save(base_scene(2), "img3.jpg", 10, 20)

    img4 = base_scene(4).filter(ImageFilter.GaussianBlur(6))  # low-quality: heavy blur
    save(img4, "img4.jpg", 10, 40, quality=70)

    # P6 bg-remove subject: red disc on plain green
    subject = Image.new("RGB", (640, 640), (40, 180, 60))
    d = ImageDraw.Draw(subject)
    d.ellipse((160, 160, 480, 480), fill=(220, 40, 50))
    d.ellipse((240, 240, 300, 300), fill=(255, 255, 255))
    subject.save(OUT / "subject.png")
    print("  subject.png")


if __name__ == "__main__":
    main()
