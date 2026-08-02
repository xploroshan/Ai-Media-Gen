#!/usr/bin/env python3
"""Download the CC0 seed tracks listed in assets/music/SOURCES.md (SPEC §2).

Best-effort: skips files that already exist, warns (does not fail) on network
errors — dev/CI use the synthetic fixture track instead.
"""

from __future__ import annotations

import sys
import urllib.request
from pathlib import Path

TRACKS = {
    "seed-upbeat.mp3": "https://freepd.com/music/Funshine.mp3",
    "seed-cinematic.mp3": "https://freepd.com/music/Distant%20Lands.mp3",
}

OUT_DIR = Path(__file__).resolve().parent.parent / "assets" / "music"


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    failures = 0
    for name, url in TRACKS.items():
        dest = OUT_DIR / name
        if dest.exists():
            print(f"  {name}: already present")
            continue
        try:
            print(f"  {name}: downloading {url}")
            tmp = dest.with_suffix(".part")
            urllib.request.urlretrieve(url, tmp)  # noqa: S310 - fixed CC0 source list
            tmp.rename(dest)
        except Exception as exc:  # noqa: BLE001 - best-effort fetch
            failures += 1
            print(f"  {name}: FAILED ({exc}) — continuing", file=sys.stderr)
    print("done; run `pnpm seed` to register downloaded tracks")
    return 0  # never hard-fail: seed music is optional in dev/CI


if __name__ == "__main__":
    raise SystemExit(main())
