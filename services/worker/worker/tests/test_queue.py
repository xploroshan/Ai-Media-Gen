"""Queue semantics tests (SPEC §5.3). Integration tests need live postgres."""

import os
import uuid

import pytest
from sqlalchemy import text

pytestmark = pytest.mark.integration

if not os.environ.get("DATABASE_URL"):
    pytest.skip("DATABASE_URL not set", allow_module_level=True)

from worker.lib import db  # noqa: E402


@pytest.fixture()
def clean_jobs():
    marker = f"test-{uuid.uuid4().hex[:8]}"
    yield marker
    with db.get_engine().begin() as conn:
        conn.execute(text("DELETE FROM jobs WHERE owner_id = :m"), {"m": marker})


def enqueue(marker: str, priority: int = 5, job_type: str = "analyze_media") -> str:
    return db.enqueue_job(job_type, {"assetId": "a1"}, owner_id=marker, priority=priority)


def test_claim_respects_priority_and_marks_running(clean_jobs):
    low = enqueue(clean_jobs, priority=9)
    high = enqueue(clean_jobs, priority=1)
    job = db.claim_job("w1")
    assert job is not None
    assert job["id"] == high
    with db.get_engine().begin() as conn:
        row = conn.execute(
            text("SELECT status, locked_by, attempts FROM jobs WHERE id=:id"), {"id": high}
        ).one()
    assert row.status == "running"
    assert row.locked_by == "w1"
    assert row.attempts == 1
    # cleanup claim of the low-priority job so fixture delete works cleanly
    job2 = db.claim_job("w1")
    assert job2 is not None and job2["id"] == low


def test_claim_type_filter(clean_jobs):
    enqueue(clean_jobs, job_type="analyze_media")
    render = enqueue(clean_jobs, job_type="render_preview")
    job = db.claim_job("w1", types=["render_preview", "render_final"])
    assert job is not None
    assert job["id"] == render


def test_complete_and_result(clean_jobs):
    job_id = enqueue(clean_jobs)
    db.claim_job("w1")
    db.complete_job(job_id, {"ok": True})
    with db.get_engine().begin() as conn:
        row = conn.execute(
            text("SELECT status, result, finished_at FROM jobs WHERE id=:id"), {"id": job_id}
        ).one()
    assert row.status == "done"
    assert row.result == {"ok": True}
    assert row.finished_at is not None


def test_fail_retries_with_backoff_then_fails(clean_jobs):
    job_id = enqueue(clean_jobs)

    job = db.claim_job("w-fail")
    assert job is not None and job["id"] == job_id
    status = db.fail_job(job_id, "boom 1", attempts=job["attempts"])
    assert status == "queued"
    with db.get_engine().begin() as conn:
        row = conn.execute(
            text("SELECT status, run_after, error FROM jobs WHERE id=:id"), {"id": job_id}
        ).one()
    assert row.status == "queued"
    assert row.run_after is not None  # backoff scheduled
    assert "boom 1" in row.error

    # not claimable while run_after is in the future
    assert db.claim_job("w-fail") is None

    # make it due, fail twice more -> terminal failure
    for attempt_error in ("boom 2", "boom 3"):
        with db.get_engine().begin() as conn:
            conn.execute(
                text("UPDATE jobs SET run_after = now() - interval '1 sec' WHERE id=:id"),
                {"id": job_id},
            )
        job = db.claim_job("w-fail")
        assert job is not None and job["id"] == job_id
        status = db.fail_job(job_id, attempt_error, attempts=job["attempts"])

    assert status == "failed"
    with db.get_engine().begin() as conn:
        row = conn.execute(
            text("SELECT status, attempts, error FROM jobs WHERE id=:id"), {"id": job_id}
        ).one()
    assert row.status == "failed"
    assert row.attempts == 3
    assert "boom 3" in row.error


def test_sweeper_requeues_stale_running(clean_jobs):
    job_id = enqueue(clean_jobs)
    db.claim_job("w-stale")
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


def test_progress_update(clean_jobs):
    job_id = enqueue(clean_jobs)
    db.claim_job("w1")
    db.update_progress(job_id, 42)
    with db.get_engine().begin() as conn:
        row = conn.execute(text("SELECT result FROM jobs WHERE id=:id"), {"id": job_id}).one()
    assert row.result["progress"] == 42
