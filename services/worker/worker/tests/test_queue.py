"""Queue semantics tests (SPEC §5.3). Integration tests need live postgres.

Each test enqueues under a unique job type and claims with a type filter so
runs never race real jobs (or each other) in a shared database.
"""

import os
import uuid

import pytest
from sqlalchemy import text

pytestmark = pytest.mark.integration

if not os.environ.get("DATABASE_URL"):
    pytest.skip("DATABASE_URL not set", allow_module_level=True)

from worker.lib import db  # noqa: E402


@pytest.fixture()
def marker():
    m = f"test-{uuid.uuid4().hex[:8]}"
    yield m
    with db.get_engine().begin() as conn:
        conn.execute(text("DELETE FROM jobs WHERE owner_id = :m"), {"m": m})


def enqueue(marker: str, priority: int = 5) -> str:
    return db.enqueue_job(f"qtest_{marker}", {"assetId": "a1"}, owner_id=marker, priority=priority)


def claim(marker: str, worker_id: str):
    return db.claim_job(worker_id, types=[f"qtest_{marker}"])


def test_claim_respects_priority_and_marks_running(marker):
    enqueue(marker, priority=9)
    high = enqueue(marker, priority=1)
    job = claim(marker, "w1")
    assert job is not None
    assert job["id"] == high
    with db.get_engine().begin() as conn:
        row = conn.execute(
            text("SELECT status, locked_by, attempts FROM jobs WHERE id=:id"), {"id": high}
        ).one()
    assert row.status == "running"
    assert row.locked_by == "w1"
    assert row.attempts == 1


def test_claim_type_filter(marker):
    other = db.enqueue_job(f"other_{marker}", {"assetId": "a1"}, owner_id=marker)
    wanted = enqueue(marker)
    job = claim(marker, "w1")
    assert job is not None
    assert job["id"] == wanted
    assert job["id"] != other


def test_complete_and_result(marker):
    job_id = enqueue(marker)
    claim(marker, "w1")
    assert db.complete_job(job_id, "w1", {"ok": True}) is True
    with db.get_engine().begin() as conn:
        row = conn.execute(
            text("SELECT status, result, finished_at FROM jobs WHERE id=:id"), {"id": job_id}
        ).one()
    assert row.status == "done"
    assert row.result == {"ok": True}
    assert row.finished_at is not None


def test_complete_requires_lease(marker):
    job_id = enqueue(marker)
    claim(marker, "w1")
    # a worker that lost the lease cannot complete the job
    assert db.complete_job(job_id, "w2", {"ok": True}) is False
    with db.get_engine().begin() as conn:
        row = conn.execute(text("SELECT status FROM jobs WHERE id=:id"), {"id": job_id}).one()
    assert row.status == "running"


def test_heartbeat_lease(marker):
    job_id = enqueue(marker)
    claim(marker, "w1")
    assert db.heartbeat(job_id, "w1") is True
    assert db.heartbeat(job_id, "w2") is False  # not the lease holder


def test_fail_retries_with_backoff_then_fails(marker):
    job_id = enqueue(marker)

    job = claim(marker, "w-fail")
    assert job is not None and job["id"] == job_id
    status = db.fail_job(job_id, "w-fail", "boom 1", attempts=job["attempts"])
    assert status == "queued"
    with db.get_engine().begin() as conn:
        row = conn.execute(
            text("SELECT status, run_after, error FROM jobs WHERE id=:id"), {"id": job_id}
        ).one()
    assert row.status == "queued"
    assert row.run_after is not None  # backoff scheduled
    assert "boom 1" in row.error

    # not claimable while run_after is in the future
    assert claim(marker, "w-fail") is None

    # make it due, fail twice more -> terminal failure
    for attempt_error in ("boom 2", "boom 3"):
        with db.get_engine().begin() as conn:
            conn.execute(
                text("UPDATE jobs SET run_after = now() - interval '1 sec' WHERE id=:id"),
                {"id": job_id},
            )
        job = claim(marker, "w-fail")
        assert job is not None and job["id"] == job_id
        status = db.fail_job(job_id, "w-fail", attempt_error, attempts=job["attempts"])

    assert status == "failed"
    with db.get_engine().begin() as conn:
        row = conn.execute(
            text("SELECT status, attempts, error FROM jobs WHERE id=:id"), {"id": job_id}
        ).one()
    assert row.status == "failed"
    assert row.attempts == 3
    assert "boom 3" in row.error


def test_fail_reports_lost_lease(marker):
    job_id = enqueue(marker)
    job = claim(marker, "w1")
    assert db.fail_job(job_id, "w2", "boom", attempts=job["attempts"]) == "lost"


def test_sweeper_requeues_stale_running(marker):
    job_id = enqueue(marker)
    claim(marker, "w-stale")
    with db.get_engine().begin() as conn:
        conn.execute(
            text("UPDATE jobs SET locked_at = now() - interval '10 min' WHERE id=:id"),
            {"id": job_id},
        )
    touched = db.sweep_stale_jobs()
    assert touched >= 1
    with db.get_engine().begin() as conn:
        row = conn.execute(text("SELECT status FROM jobs WHERE id=:id"), {"id": job_id}).one()
    assert row.status == "queued"  # attempts=1 < 3 -> requeued


def test_requeue_own_running(marker):
    job_id = enqueue(marker)
    claim(marker, "w-drain")
    assert db.requeue_own_running("w-drain") >= 1
    with db.get_engine().begin() as conn:
        row = conn.execute(
            text("SELECT status, attempts FROM jobs WHERE id=:id"), {"id": job_id}
        ).one()
    assert row.status == "queued"
    assert row.attempts == 0  # handed back without burning an attempt


def test_progress_update(marker):
    job_id = enqueue(marker)
    claim(marker, "w1")
    db.update_progress(job_id, "w1", 42)
    with db.get_engine().begin() as conn:
        row = conn.execute(text("SELECT result FROM jobs WHERE id=:id"), {"id": job_id}).one()
    assert row.result["progress"] == 42
    # a non-holder's progress write is ignored
    db.update_progress(job_id, "w2", 99)
    with db.get_engine().begin() as conn:
        row = conn.execute(text("SELECT result FROM jobs WHERE id=:id"), {"id": job_id}).one()
    assert row.result["progress"] == 42
