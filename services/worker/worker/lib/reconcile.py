"""Sweeper reconciliation — repair entities stranded by dead jobs.

A job that exhausts its retries flips to 'failed', but the entity it was
driving (project / export / media_asset) can be left in an in-progress status
forever. Each pass here finds entities whose driving job is no longer
queued/running (failed, lost, or never enqueued) after a grace period and
moves them to a terminal or recoverable state. All updates are guarded by the
NOT EXISTS check so an in-flight retry (queued with a future run_after) is
left alone.
"""

from __future__ import annotations

from sqlalchemy import text

from worker.lib.db import get_engine

GRACE_SEC = 600  # don't touch anything younger than 10 min


def reconcile_stuck_entities() -> int:
    """Returns the number of rows repaired across all entity kinds."""
    fixed = 0
    with get_engine().begin() as conn:
        # projects stuck 'rendering' with no live autoedit/render job -> back to draft
        fixed += conn.execute(
            text(
                """
                UPDATE projects p SET status='draft', updated_at=now()
                WHERE p.status='rendering'
                  AND p.updated_at < now() - make_interval(secs => :grace)
                  AND NOT EXISTS (
                    SELECT 1 FROM jobs j
                    WHERE j.status IN ('queued','running')
                      AND j.type IN ('autoedit_generate','render_preview','render_final')
                      AND j.payload->>'projectId' = p.id
                  )
                """
            ),
            {"grace": GRACE_SEC},
        ).rowcount
        # exports stranded 'queued' whose render_final job died -> failed
        fixed += conn.execute(
            text(
                """
                UPDATE exports e SET status='failed'
                WHERE e.status='queued'
                  AND e.created_at < now() - make_interval(secs => :grace)
                  AND NOT EXISTS (
                    SELECT 1 FROM jobs j
                    WHERE j.status IN ('queued','running')
                      AND j.type='render_final'
                      AND j.payload->>'exportId' = e.id
                  )
                """
            ),
            {"grace": GRACE_SEC},
        ).rowcount
        # media assets stuck 'analyzing' whose analyze job died -> failed
        fixed += conn.execute(
            text(
                """
                UPDATE media_assets a SET status='failed'
                WHERE a.status='analyzing'
                  AND a.created_at < now() - make_interval(secs => :grace)
                  AND NOT EXISTS (
                    SELECT 1 FROM jobs j
                    WHERE j.status IN ('queued','running')
                      AND j.type='analyze_media'
                      AND j.payload->>'assetId' = a.id
                  )
                """
            ),
            {"grace": GRACE_SEC},
        ).rowcount
    return fixed
