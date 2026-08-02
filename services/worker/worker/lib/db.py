"""Postgres job queue — SPEC §5.3 semantics.

Claim uses FOR UPDATE SKIP LOCKED; heartbeat bumps locked_at; a sweeper
re-queues stale running jobs (locked_at older than 5 min) while attempts < 3,
else fails them. Failed jobs retry with exponential delay (30 s, 2 min) up to
3 attempts via run_after (see DECISIONS.md #6).
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import Engine, create_engine, text

from worker.lib.settings import get_settings

RETRY_DELAYS_SEC = [30, 120]  # attempt 1 -> 30 s, attempt 2 -> 2 min; attempt 3 fails for good
MAX_ATTEMPTS = 3
STALE_AFTER_SEC = 300

_engine: Engine | None = None


def get_engine() -> Engine:
    global _engine
    if _engine is None:
        _engine = create_engine(get_settings().sqlalchemy_url, pool_pre_ping=True, pool_size=8)
    return _engine


def utcnow() -> datetime:
    return datetime.now(UTC)


def claim_job(worker_id: str, types: list[str] | None = None) -> dict[str, Any] | None:
    """Claim the highest-priority queued job (optionally restricted to types)."""
    type_filter = "AND type = ANY(:types)" if types else ""
    sql = text(
        f"""
        UPDATE jobs SET status='running', locked_by=:worker_id, locked_at=now(),
                        attempts=attempts+1
        WHERE id = (
            SELECT id FROM jobs
            WHERE status='queued' AND (run_after IS NULL OR run_after <= now())
            {type_filter}
            ORDER BY priority, created_at
            FOR UPDATE SKIP LOCKED
            LIMIT 1
        )
        RETURNING id, type, payload, attempts, owner_id, priority
        """
    )
    params: dict[str, Any] = {"worker_id": worker_id}
    if types:
        params["types"] = types
    with get_engine().begin() as conn:
        row = conn.execute(sql, params).mappings().first()
    return dict(row) if row else None


def heartbeat(job_id: str) -> None:
    with get_engine().begin() as conn:
        conn.execute(
            text("UPDATE jobs SET locked_at=now() WHERE id=:id AND status='running'"),
            {"id": job_id},
        )


def complete_job(job_id: str, result: dict[str, Any] | None = None) -> None:
    with get_engine().begin() as conn:
        conn.execute(
            text(
                "UPDATE jobs SET status='done', result=CAST(:result AS jsonb), error=NULL, "
                "finished_at=now(), locked_by=NULL, locked_at=NULL WHERE id=:id"
            ),
            {"id": job_id, "result": json.dumps(result or {})},
        )


def update_progress(job_id: str, progress: int, extra: dict[str, Any] | None = None) -> None:
    payload = {"progress": max(0, min(100, progress)), **(extra or {})}
    with get_engine().begin() as conn:
        conn.execute(
            text(
                "UPDATE jobs SET result = COALESCE(result,'{}'::jsonb) || CAST(:p AS jsonb) "
                "WHERE id=:id AND status='running'"
            ),
            {"id": job_id, "p": json.dumps(payload)},
        )


def fail_job(job_id: str, error: str, attempts: int) -> str:
    """Fail or schedule retry. Returns final status ('queued' retry or 'failed')."""
    if attempts < MAX_ATTEMPTS:
        delay = RETRY_DELAYS_SEC[min(attempts - 1, len(RETRY_DELAYS_SEC) - 1)]
        with get_engine().begin() as conn:
            conn.execute(
                text(
                    "UPDATE jobs SET status='queued', error=:error, locked_by=NULL, "
                    "locked_at=NULL, run_after=now() + make_interval(secs => :delay) "
                    "WHERE id=:id"
                ),
                {"id": job_id, "error": error[:2000], "delay": delay},
            )
        return "queued"
    with get_engine().begin() as conn:
        conn.execute(
            text(
                "UPDATE jobs SET status='failed', error=:error, finished_at=now(), "
                "locked_by=NULL, locked_at=NULL WHERE id=:id"
            ),
            {"id": job_id, "error": error[:2000]},
        )
    return "failed"


def sweep_stale_jobs() -> int:
    """Re-queue running jobs whose heartbeat went stale; fail exhausted ones."""
    with get_engine().begin() as conn:
        requeued = conn.execute(
            text(
                "UPDATE jobs SET status='queued', locked_by=NULL, locked_at=NULL "
                "WHERE status='running' AND locked_at < now() - make_interval(secs => :stale) "
                "AND attempts < :max"
            ),
            {"stale": STALE_AFTER_SEC, "max": MAX_ATTEMPTS},
        ).rowcount
        failed = conn.execute(
            text(
                "UPDATE jobs SET status='failed', error='worker lost (stale heartbeat)', "
                "finished_at=now(), locked_by=NULL, locked_at=NULL "
                "WHERE status='running' AND locked_at < now() - make_interval(secs => :stale) "
                "AND attempts >= :max"
            ),
            {"stale": STALE_AFTER_SEC, "max": MAX_ATTEMPTS},
        ).rowcount
    return requeued + failed


def enqueue_job(
    job_type: str,
    payload: dict[str, Any],
    owner_id: str | None = None,
    priority: int = 5,
) -> str:
    with get_engine().begin() as conn:
        row = conn.execute(
            text(
                "INSERT INTO jobs (id, type, status, priority, payload, owner_id, created_at) "
                "VALUES (substr(md5(random()::text || clock_timestamp()::text), 1, 25), "
                ":type, 'queued', :priority, CAST(:payload AS jsonb), :owner_id, now()) "
                "RETURNING id"
            ),
            {
                "type": job_type,
                "priority": priority,
                "payload": json.dumps(payload),
                "owner_id": owner_id,
            },
        ).first()
    assert row is not None
    return row[0]
