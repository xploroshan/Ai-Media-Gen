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
                db.heartbeat(job_id)
            except Exception:  # pragma: no cover - best effort
                log.exception("heartbeat failed for %s", job_id)

    hb_thread = threading.Thread(target=hb, daemon=True)
    hb_thread.start()
    try:
        if handler is None:
            raise RuntimeError(f"no handler for job type {job['type']!r}")
        payload = job.get("payload") or {}
        log.info("job %s (%s) start attempt=%s", job_id, job["type"], job["attempts"])
        result = handler({**job, "payload": payload})
        db.complete_job(job_id, result)
        log.info("job %s done", job_id)
    except Exception as exc:
        log.error("job %s failed: %s\n%s", job_id, exc, traceback.format_exc())
        status = db.fail_job(job_id, f"{type(exc).__name__}: {exc}", job["attempts"])
        log.info("job %s -> %s", job_id, status)
    finally:
        hb_stop.set()


def _poller(slot: int, worker_id: str, render_slot: bool) -> None:
    """Each slot polls for work. One dedicated slot prefers (and reserves) renders."""
    while not _stop.is_set():
        try:
            job = None
            if render_slot:
                job = db.claim_job(worker_id, types=sorted(RENDER_TYPES))
            if job is None:
                types = None if render_slot else sorted(set(HANDLERS) - RENDER_TYPES) or None
                if not render_slot or HANDLERS:
                    job = db.claim_job(worker_id, types=types)
            if job:
                _run_job(job, worker_id)
                continue
        except Exception:
            log.exception("poller slot %s error", slot)
        _stop.wait(1.0)


def _sweeper() -> None:
    from worker.lib.credits import reconcile_failed_generations

    while not _stop.wait(60):
        try:
            n = db.sweep_stale_jobs()
            if n:
                log.info("sweeper touched %s stale jobs", n)
            refunded = reconcile_failed_generations()
            if refunded:
                log.info("sweeper refunded %s orphaned generations", refunded)
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

    def _shutdown(*_: object) -> None:
        log.info("shutting down")
        _stop.set()

    signal.signal(signal.SIGTERM, _shutdown)
    signal.signal(signal.SIGINT, _shutdown)

    uvicorn.run(app, host="0.0.0.0", port=8001, log_level="warning")


if __name__ == "__main__":
    main()
