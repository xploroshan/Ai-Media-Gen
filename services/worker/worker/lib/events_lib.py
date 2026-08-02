"""Event clustering — pure logic (SPEC §6.2), unit-tested without a DB."""

from __future__ import annotations

import math
from datetime import datetime
from typing import Any

GAP_HOURS = 4.0
MAX_KM = 25.0
MIN_CLUSTER = 6


def haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def cluster_assets(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """items: [{id, takenAt: datetime, lat: float|None, lng: float|None}] sorted or not.

    Breaks on time gap > 4 h OR haversine > 25 km; keeps clusters >= 6 assets.
    Returns [{assetIds, startAt, endAt, title}].
    """
    dated = [i for i in items if isinstance(i.get("takenAt"), datetime)]
    dated.sort(key=lambda i: i["takenAt"])
    clusters: list[list[dict]] = []
    current: list[dict] = []
    for item in dated:
        if not current:
            current = [item]
            continue
        prev = current[-1]
        gap_h = (item["takenAt"] - prev["takenAt"]).total_seconds() / 3600.0
        far = False
        if (
            item.get("lat") is not None and item.get("lng") is not None
            and prev.get("lat") is not None and prev.get("lng") is not None
        ):
            far = haversine_km(prev["lat"], prev["lng"], item["lat"], item["lng"]) > MAX_KM
        if gap_h > GAP_HOURS or far:
            clusters.append(current)
            current = [item]
        else:
            current.append(item)
    if current:
        clusters.append(current)

    out = []
    for cluster in clusters:
        if len(cluster) < MIN_CLUSTER:
            continue
        start: datetime = cluster[0]["takenAt"]
        end: datetime = cluster[-1]["takenAt"]
        out.append(
            {
                "assetIds": [c["id"] for c in cluster],
                "startAt": start,
                "endAt": end,
                "title": format_title(start, end),
            }
        )
    return out


def format_title(start: datetime, end: datetime) -> str:
    """'{Month D–D}' per SPEC §6.2 (single day: '{Month D}')."""
    if (start.year, start.month, start.day) == (end.year, end.month, end.day):
        return f"{start.strftime('%b')} {start.day}"
    if (start.year, start.month) == (end.year, end.month):
        return f"{start.strftime('%b')} {start.day}–{end.day}"
    return f"{start.strftime('%b')} {start.day}–{end.strftime('%b')} {end.day}"
