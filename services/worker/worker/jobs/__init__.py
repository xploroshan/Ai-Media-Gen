"""Job handler registry. Handlers are thin: validate payload, call lib functions."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

# handler(job: dict) -> result dict; raises on failure
Handler = Callable[[dict[str, Any]], dict[str, Any]]

HANDLERS: dict[str, Handler] = {}

# Job types whose handlers occupy the dedicated render slot (SPEC §5.3)
RENDER_TYPES = {"render_preview", "render_final"}


def register(job_type: str) -> Callable[[Handler], Handler]:
    def deco(fn: Handler) -> Handler:
        HANDLERS[job_type] = fn
        return fn

    return deco


def load_all() -> None:
    """Import handler modules for their side-effect registrations."""
    # Populated phase by phase (P1: analyze_media/detect_events, P2: autoedit/render, ...)
    import contextlib

    for mod in (
        "worker.jobs.analyze_media",
        "worker.jobs.events",
        "worker.jobs.beats",
        "worker.jobs.autoedit",
        "worker.jobs.render",
        "worker.jobs.transcribe",
        "worker.jobs.generate_ai",
        "worker.jobs.image_ops",
    ):
        with contextlib.suppress(ModuleNotFoundError):
            __import__(mod)
