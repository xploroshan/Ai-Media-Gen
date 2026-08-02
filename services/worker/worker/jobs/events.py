"""detect_events handler — clusters ready assets into Events (SPEC §6.2)."""

from __future__ import annotations

from worker.jobs import register
from worker.lib import assets
from worker.lib.events_lib import cluster_assets


@register("detect_events")
def handle(job: dict) -> dict:
    owner_id = job["payload"]["ownerId"]
    ready = assets.list_ready_assets(owner_id)
    items = [
        {
            "id": a["id"],
            "takenAt": a.get("taken_at"),
            "lat": a.get("gps_lat"),
            "lng": a.get("gps_lng"),
        }
        for a in ready
    ]
    clusters = cluster_assets(items)
    event_ids = []
    for cluster in clusters:
        event_ids.append(
            assets.upsert_event(
                owner_id, cluster["title"], cluster["startAt"], cluster["endAt"],
                cluster["assetIds"],
            )
        )
    return {"events": len(event_ids), "eventIds": event_ids}
