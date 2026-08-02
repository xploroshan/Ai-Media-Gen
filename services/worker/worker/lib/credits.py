"""Worker-side credit refunds — atomic, append-only ledger (SPEC §8.4, §5.3).

The spend path lives web-side (apps/web/src/lib/credits.ts). Both sides obey:
SELECT ... FOR UPDATE on the profile row, ledger row with balance_after, then
balance update — all inside one transaction. Ledger replay must equal balance.
"""

from __future__ import annotations

from sqlalchemy import text

from worker.lib.db import get_engine


def refund_generation(generation_id: str, reason: str = "refund") -> bool:
    """Refund a failed generation atomically. Idempotent: second call is a no-op.

    Returns True when a refund was applied.
    """
    with get_engine().begin() as conn:
        gen = conn.execute(
            text("SELECT * FROM generations WHERE id=:id FOR UPDATE"), {"id": generation_id}
        ).mappings().first()
        if gen is None:
            raise RuntimeError(f"generation {generation_id} not found")
        if gen["status"] == "refunded" or gen["credit_cost"] <= 0:
            return False
        already = conn.execute(
            text("SELECT 1 FROM credit_ledger WHERE ref_id=:id AND reason=:r LIMIT 1"),
            {"id": generation_id, "r": reason},
        ).first()
        if already:
            return False

        profile = conn.execute(
            text("SELECT credits_balance FROM profiles WHERE id=:id FOR UPDATE"),
            {"id": gen["owner_id"]},
        ).mappings().first()
        if profile is None:
            raise RuntimeError(f"profile {gen['owner_id']} missing")
        new_balance = profile["credits_balance"] + gen["credit_cost"]
        conn.execute(
            text(
                "INSERT INTO credit_ledger (id, owner_id, delta, reason, ref_id, "
                "balance_after, created_at) VALUES "
                "(substr(md5(random()::text || clock_timestamp()::text), 1, 25), "
                ":owner, :delta, :reason, :ref, :bal, now())"
            ),
            {
                "owner": gen["owner_id"],
                "delta": gen["credit_cost"],
                "reason": reason,
                "ref": generation_id,
                "bal": new_balance,
            },
        )
        conn.execute(
            text("UPDATE profiles SET credits_balance=:bal WHERE id=:id"),
            {"bal": new_balance, "id": gen["owner_id"]},
        )
        conn.execute(
            text("UPDATE generations SET status='refunded' WHERE id=:id"),
            {"id": generation_id},
        )
    return True


def reconcile_failed_generations() -> int:
    """Refund generations whose job failed without reaching the terminal handler
    (e.g. worker killed, stale-heartbeat sweep). Called periodically by the sweeper.
    """
    with get_engine().begin() as conn:
        rows = conn.execute(
            text(
                "SELECT g.id FROM generations g JOIN jobs j ON j.id = g.job_id "
                "WHERE j.status = 'failed' AND g.status IN ('queued', 'running')"
            )
        ).all()
    refunded = 0
    for (gen_id,) in rows:
        with get_engine().begin() as conn:
            conn.execute(
                text("UPDATE generations SET status='failed' WHERE id=:id"), {"id": gen_id}
            )
        if refund_generation(gen_id):
            refunded += 1
    return refunded


def replay_ledger_balance(owner_id: str) -> tuple[int, int, bool]:
    """(replayed_sum, current_balance, rows_consistent) — pytest property (§8.4)."""
    with get_engine().begin() as conn:
        rows = conn.execute(
            text(
                "SELECT delta, balance_after FROM credit_ledger "
                "WHERE owner_id=:o ORDER BY created_at, id"
            ),
            {"o": owner_id},
        ).all()
        balance = conn.execute(
            text("SELECT credits_balance FROM profiles WHERE id=:o"), {"o": owner_id}
        ).scalar()
    running = 0
    consistent = True
    for delta, balance_after in rows:
        running += delta
        if balance_after != running:
            consistent = False
    return running, int(balance or 0), consistent
