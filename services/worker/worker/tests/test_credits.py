"""P5 exit tests — ledger atomicity + refund + replay reconciliation (SPEC §8.4)."""

import json
import os
import uuid

import pytest
from sqlalchemy import text

pytestmark = pytest.mark.integration

if not os.environ.get("DATABASE_URL"):
    pytest.skip("DATABASE_URL not set", allow_module_level=True)

from worker.lib import db  # noqa: E402
from worker.lib.credits import (  # noqa: E402
    reconcile_failed_generations,
    refund_generation,
    replay_ledger_balance,
)


def _cuid() -> str:
    return uuid.uuid4().hex[:25]


@pytest.fixture()
def owner():
    """A throwaway profile with 120 credits and a signup ledger row."""
    owner_id = f"test-{uuid.uuid4().hex[:16]}"
    with db.get_engine().begin() as conn:
        conn.execute(
            text(
                "INSERT INTO profiles (id, locale, plan, credits_balance, is_admin, created_at) "
                "VALUES (:id, 'en', 'free', 120, false, now())"
            ),
            {"id": owner_id},
        )
        conn.execute(
            text(
                "INSERT INTO credit_ledger (id, owner_id, delta, reason, balance_after, "
                "created_at) VALUES (:lid, :id, 120, 'signup_bonus', 120, now())"
            ),
            {"lid": _cuid(), "id": owner_id},
        )
    yield owner_id
    with db.get_engine().begin() as conn:
        conn.execute(text("DELETE FROM credit_ledger WHERE owner_id=:id"), {"id": owner_id})
        conn.execute(text("DELETE FROM generations WHERE owner_id=:id"), {"id": owner_id})
        conn.execute(text("DELETE FROM jobs WHERE owner_id=:id"), {"id": owner_id})
        conn.execute(text("DELETE FROM profiles WHERE id=:id"), {"id": owner_id})


def spend(owner_id: str, cost: int, status: str = "queued", with_job: bool = False) -> str:
    """Worker-side mirror of the web spend transaction, for exercising the ledger."""
    gen_id = _cuid()
    with db.get_engine().begin() as conn:
        balance = conn.execute(
            text("SELECT credits_balance FROM profiles WHERE id=:id FOR UPDATE"),
            {"id": owner_id},
        ).scalar()
        assert balance is not None and balance >= cost, "insufficient credits in test"
        new_balance = balance - cost
        job_id = None
        if with_job:
            job_id = _cuid()
            conn.execute(
                text(
                    "INSERT INTO jobs (id, type, status, priority, payload, owner_id, "
                    "created_at, attempts) VALUES (:jid, 'generate_ai', 'failed', 5, "
                    "CAST(:p AS jsonb), :o, now(), 3)"
                ),
                {"jid": job_id, "p": json.dumps({"generationId": gen_id}), "o": owner_id},
            )
        conn.execute(
            text(
                "INSERT INTO generations (id, owner_id, kind, provider_id, model_slug, prompt, "
                "params, credit_cost, status, job_id, created_at) VALUES "
                "(:id, :o, 't2i', 'stub', 'stub/model', 'test', '{}'::jsonb, :c, :s, :jid, now())"
            ),
            {"id": gen_id, "o": owner_id, "c": cost, "s": status, "jid": job_id},
        )
        conn.execute(
            text(
                "INSERT INTO credit_ledger (id, owner_id, delta, reason, ref_id, balance_after, "
                "created_at) VALUES (:lid, :o, :d, 'generation', :ref, :b, now())"
            ),
            {"lid": _cuid(), "o": owner_id, "d": -cost, "ref": gen_id, "b": new_balance},
        )
        conn.execute(
            text("UPDATE profiles SET credits_balance=:b WHERE id=:id"),
            {"b": new_balance, "id": owner_id},
        )
    return gen_id


def balance_of(owner_id: str) -> int:
    with db.get_engine().begin() as conn:
        return conn.execute(
            text("SELECT credits_balance FROM profiles WHERE id=:id"), {"id": owner_id}
        ).scalar()


class TestLedger:
    def test_replay_equals_balance_after_spends(self, owner):
        spend(owner, 10)
        spend(owner, 25)
        replayed, balance, consistent = replay_ledger_balance(owner)
        assert replayed == balance == 85
        assert consistent

    def test_refund_restores_balance_and_reconciles(self, owner):
        gen = spend(owner, 30, status="failed")
        assert balance_of(owner) == 90
        assert refund_generation(gen) is True
        assert balance_of(owner) == 120
        replayed, balance, consistent = replay_ledger_balance(owner)
        assert replayed == balance == 120
        assert consistent
        with db.get_engine().begin() as conn:
            status = conn.execute(
                text("SELECT status FROM generations WHERE id=:id"), {"id": gen}
            ).scalar()
        assert status == "refunded"

    def test_refund_is_idempotent(self, owner):
        gen = spend(owner, 30, status="failed")
        assert refund_generation(gen) is True
        assert refund_generation(gen) is False  # second call: no-op
        assert balance_of(owner) == 120
        _, _, consistent = replay_ledger_balance(owner)
        assert consistent

    def test_ledger_is_append_only_running_sum(self, owner):
        """Property: after arbitrary spend/refund sequences, replay == balance."""
        gens = [spend(owner, c, status="failed") for c in (5, 7, 11)]
        refund_generation(gens[1])
        spend(owner, 13)
        refund_generation(gens[0])
        replayed, balance, consistent = replay_ledger_balance(owner)
        assert consistent, "every ledger row's balance_after must equal the running sum"
        assert replayed == balance
        assert balance == 120 - 5 - 7 - 11 - 13 + 7 + 5

    def test_refund_refuses_delivered_generation(self, owner):
        gen = spend(owner, 30, status="done")
        assert refund_generation(gen) is False  # results were delivered
        assert balance_of(owner) == 90
        with db.get_engine().begin() as conn:
            status = conn.execute(
                text("SELECT status FROM generations WHERE id=:id"), {"id": gen}
            ).scalar()
        assert status == "done"

    def test_refund_idempotent_across_reasons(self, owner):
        """A partial_refund row already returned credits — a full refund must not stack."""
        gen = spend(owner, 30, status="failed")
        with db.get_engine().begin() as conn:
            conn.execute(
                text(
                    "INSERT INTO credit_ledger (id, owner_id, delta, reason, ref_id, "
                    "balance_after, created_at) VALUES (:lid, :o, 15, 'partial_refund', "
                    ":ref, 105, now())"
                ),
                {"lid": _cuid(), "o": owner, "ref": gen},
            )
            conn.execute(
                text("UPDATE profiles SET credits_balance=105 WHERE id=:id"), {"id": owner}
            )
        assert refund_generation(gen) is False  # positive-delta row exists for this ref
        assert balance_of(owner) == 105

    def test_concurrent_refunds_apply_exactly_once(self, owner):
        import threading

        gen = spend(owner, 40, status="failed")
        results: list[bool] = []
        lock = threading.Lock()

        def attempt() -> None:
            applied = refund_generation(gen)
            with lock:
                results.append(applied)

        threads = [threading.Thread(target=attempt) for _ in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        assert results.count(True) == 1, "exactly one concurrent refund may win"
        assert balance_of(owner) == 120
        _, _, consistent = replay_ledger_balance(owner)
        assert consistent

    def test_reconcile_refunds_orphaned_generations(self, owner):
        gen = spend(owner, 20, status="running", with_job=True)  # job already failed
        assert balance_of(owner) == 100
        refunded = reconcile_failed_generations()
        assert refunded >= 1
        assert balance_of(owner) == 120
        with db.get_engine().begin() as conn:
            status = conn.execute(
                text("SELECT status FROM generations WHERE id=:id"), {"id": gen}
            ).scalar()
        assert status == "refunded"
