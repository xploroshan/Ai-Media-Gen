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


def base_scene(seed: int) -> Image.Image:
    """Structurally distinct scene per seed — phash (grayscale DCT) must differ
    across seeds, so geometry varies, not just color."""
    import random

    rng = random.Random(seed * 7919 + 13)
    w, h = 1280, 960
    img = Image.new("RGB", (w, h))
    px = img.load()
    angle = rng.uniform(0.5, 6.0)
    phase = rng.uniform(0, 6.28)
    for y in range(h):
        for x in range(0, w, 4):
            v = math.sin((x / w) * angle + (y / h) * rng.random() * 2 + phase)
            r = int(120 + 100 * v)
            g = int(60 + 140 * ((y / h + seed * 0.13) % 1.0))
            b = int(200 - 150 * abs(v))
            for dx in range(4):
                if x + dx < w:
                    px[x + dx, y] = (max(0, min(255, r)), max(0, min(255, g)), max(0, min(255, b)))
    draw = ImageDraw.Draw(img)
    # seed-dependent geometry: blocks / discs / stripes in random layouts
    for _ in range(rng.randint(6, 14)):
        x0, y0 = rng.randint(0, w - 200), rng.randint(0, h - 200)
        size = rng.randint(60, 260)
        color = (rng.randint(0, 255), rng.randint(0, 255), rng.randint(0, 255))
        shape = rng.choice(["rect", "disc", "tri"])
        if shape == "rect":
            draw.rectangle((x0, y0, x0 + size, y0 + size), fill=color)
        elif shape == "disc":
            draw.ellipse((x0, y0, x0 + size, y0 + size), fill=color)
        else:
            draw.polygon([(x0, y0 + size), (x0 + size // 2, y0), (x0 + size, y0 + size)],
                         fill=color)
    for i in range(80):  # fine texture for sharpness scoring
        x = rng.randint(0, w - 8)
        y = rng.randint(0, h - 8)
        draw.rectangle((x, y, x + 5, y + 5),
                       fill=(rng.randint(0, 255), rng.randint(0, 255), rng.randint(0, 255)))
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

    # extra distinct scenes so shuffle has fresh candidates (P2 e2e needs
    # candidates >= slots * 1.4 for the 40% shuffle-difference floor)
    for i in range(10):
        hour = 11 + (45 + i * 7) // 60
        minute = (45 + i * 7) % 60
        save(base_scene(6 + i * 3), f"extra{i + 1}.jpg", hour, minute)

    # P6 bg-remove subject: red disc on plain green
    subject = Image.new("RGB", (640, 640), (40, 180, 60))
    d = ImageDraw.Draw(subject)
    d.ellipse((160, 160, 480, 480), fill=(220, 40, 50))
    d.ellipse((240, 240, 300, 300), fill=(255, 255, 255))
    subject.save(OUT / "subject.png")
    print("  subject.png")


if __name__ == "__main__":
    main()
