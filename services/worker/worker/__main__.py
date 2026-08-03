"""Worker entry: FastAPI /healthz + N-slot poller loop (SPEC §1, §5.3)."""

from __future__ import annotations

import logging
import os
import signal
import socket
import threading
import time
import traceback

import uvicorn
from fastapi import FastAPI

from worker.jobs import HANDLERS, RENDER_TYPES, load_all
from worker.lib import db
from worker.lib.payloads import validate_payload
from worker.lib.settings import get_settings

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
log = logging.getLogger("worker")

app = FastAPI()
_started = time.time()
_stop = threading.Event()


@app.get("/healthz")
def healthz() -> dict:
    return {"ok": True, "uptimeSec": round(time.time() - _started, 1), "handlers": sorted(HANDLERS)}


def _run_job(job: dict, worker_id: str) -> None:
    job_id = job["id"]
    handler = HANDLERS.get(job["type"])
    hb_stop = threading.Event()

    def hb() -> None:
        while not hb_stop.wait(30):
            try:
                if not db.heartbeat(job_id, worker_id):
                    # lease lost (sweeper reclaimed the job) — stop renewing
                    log.warning("job %s lease lost; heartbeat stopping", job_id)
                    return
            except Exception:  # pragma: no cover - best effort
                log.exception("heartbeat failed for %s", job_id)

    hb_thread = threading.Thread(target=hb, daemon=True)
    hb_thread.start()
    try:
        if handler is None:
            raise RuntimeError(f"no handler for job type {job['type']!r}")
        payload = validate_payload(job["type"], job.get("payload") or {})
        log.info("job %s (%s) start attempt=%s", job_id, job["type"], job["attempts"])
        result = handler({**job, "payload": payload, "workerId": worker_id})
        if db.complete_job(job_id, worker_id, result):
            log.info("job %s done", job_id)
        else:
            log.warning("job %s finished but the lease was lost — result discarded", job_id)
    except Exception as exc:
        log.error("job %s failed: %s\n%s", job_id, exc, traceback.format_exc())
        status = db.fail_job(job_id, worker_id, f"{type(exc).__name__}: {exc}", job["attempts"])
        log.info("job %s -> %s", job_id, status)
    finally:
        hb_stop.set()


def _poller(slot: int, worker_id: str, render_slot: bool) -> None:
    """Render slot polls ONLY render jobs (dedicated, §5.3); others exclude them."""
    while not _stop.is_set():
        try:
            if render_slot:
                types: list[str] | None = sorted(RENDER_TYPES)
            else:
                non_render = sorted(set(HANDLERS) - RENDER_TYPES)
                if not non_render:
                    _stop.wait(1.0)
                    continue
                types = non_render
            job = db.claim_job(worker_id, types=types)
            if job:
                _run_job(job, worker_id)
                continue
        except Exception:
            log.exception("poller slot %s error", slot)
        _stop.wait(1.0)


def _sweeper() -> None:
    from worker.lib.credits import reconcile_failed_generations
    from worker.lib.reconcile import reconcile_stuck_entities

    while not _stop.wait(60):
        try:
            n = db.sweep_stale_jobs()
            if n:
                log.info("sweeper touched %s stale jobs", n)
            refunded = reconcile_failed_generations()
            if refunded:
                log.info("sweeper refunded %s orphaned generations", refunded)
            fixed = reconcile_stuck_entities()
            if fixed:
                log.info("sweeper reconciled %s stuck entities", fixed)
        except Exception:
            log.exception("sweeper error")


def main() -> None:
    settings = get_settings()  # fail fast on bad env
    load_all()
    worker_id = settings.worker_id or f"{socket.gethostname()}-{os.getpid()}"
    log.info("worker %s starting, concurrency=%s, handlers=%s",
             worker_id, settings.worker_concurrency, sorted(HANDLERS))

    threads = [threading.Thread(target=_sweeper, daemon=True, name="sweeper")]
    n = max(1, settings.worker_concurrency)
    for slot in range(n):
        render_slot = slot == 0 and n > 1  # dedicated render slot when concurrency allows
        threads.append(
            threading.Thread(
                target=_poller, args=(slot, worker_id, render_slot), daemon=True,
                name=f"poller-{slot}",
            )
        )
    for t in threads:
        t.start()

    # uvicorn must not own the signals (it would swallow our graceful shutdown)
    server = uvicorn.Server(
        uvicorn.Config(app, host="0.0.0.0", port=8001, log_level="warning")
    )
    server.install_signal_handlers = lambda: None  # type: ignore[method-assign]

    def _shutdown(*_: object) -> None:
        log.info("shutting down: draining pollers")
        _stop.set()
        server.should_exit = True

    signal.signal(signal.SIGTERM, _shutdown)
    signal.signal(signal.SIGINT, _shutdown)

    server.run()

    # give in-flight jobs a moment, then hand back anything still running
    for t in threads:
        t.join(timeout=10)
    requeued = db.requeue_own_running(worker_id)
    if requeued:
        log.info("requeued %s in-flight jobs on shutdown", requeued)


if __name__ == "__main__":
    main()
