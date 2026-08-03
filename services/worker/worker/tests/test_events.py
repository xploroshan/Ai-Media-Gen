"""Event clustering unit tests (SPEC §6.2)."""

from datetime import datetime, timedelta

from worker.lib.events_lib import cluster_assets, format_title, haversine_km


def _items(n: int, start: datetime, step_min: int = 10, lat=None, lng=None, prefix="a"):
    return [
        {
            "id": f"{prefix}{i}",
            "takenAt": start + timedelta(minutes=step_min * i),
            "lat": lat,
            "lng": lng,
        }
        for i in range(n)
    ]


def test_single_cluster_of_six():
    items = _items(6, datetime(2026, 8, 1, 10, 0))
    clusters = cluster_assets(items)
    assert len(clusters) == 1
    assert clusters[0]["assetIds"] == [f"a{i}" for i in range(6)]
    assert clusters[0]["title"] == "Aug 1"


def test_small_groups_dropped():
    items = _items(5, datetime(2026, 8, 1, 10, 0))
    assert cluster_assets(items) == []


def test_time_gap_breaks_cluster():
    early = _items(6, datetime(2026, 8, 1, 8, 0), prefix="e")
    late = _items(6, datetime(2026, 8, 1, 20, 0), prefix="l")  # 12h gap > 4h
    clusters = cluster_assets(early + late)
    assert len(clusters) == 2
    assert {c["assetIds"][0] for c in clusters} == {"e0", "l0"}


def test_distance_breaks_cluster():
    goa = _items(6, datetime(2026, 8, 1, 10, 0), lat=15.30, lng=74.12, prefix="g")
    mumbai = _items(
        6, datetime(2026, 8, 1, 12, 0), lat=19.07, lng=72.88, prefix="m"
    )  # ~490 km away, within 4h
    clusters = cluster_assets(goa + mumbai)
    assert len(clusters) == 2


def test_undated_assets_ignored():
    items = _items(6, datetime(2026, 8, 1, 10, 0))
    items.append({"id": "x", "takenAt": None, "lat": None, "lng": None})
    clusters = cluster_assets(items)
    assert len(clusters) == 1
    assert "x" not in clusters[0]["assetIds"]


def test_multi_day_title():
    a = _items(4, datetime(2026, 8, 1, 22, 0), step_min=30)
    b = _items(4, datetime(2026, 8, 2, 1, 0), step_min=30, prefix="b")
    clusters = cluster_assets(a + b)
    assert len(clusters) == 1
    assert clusters[0]["title"] == "Aug 1–2"


def test_title_across_months():
    assert format_title(datetime(2026, 8, 31), datetime(2026, 9, 1)) == "Aug 31–Sep 1"


def test_haversine_sane():
    assert haversine_km(0, 0, 0, 0) == 0
    assert 400 < haversine_km(15.30, 74.12, 19.07, 72.88) < 500  # Goa→Mumbai ≈ 440 km
