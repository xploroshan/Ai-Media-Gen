-- ultra-review hardening: replay ordering, payload lookups, cost precision, energy curve

-- credit_ledger: monotone sequence so replay has a total order independent of
-- created_at ties (two rows in the same millisecond)
ALTER TABLE "credit_ledger" ADD COLUMN "seq" BIGSERIAL;
CREATE UNIQUE INDEX "credit_ledger_seq_key" ON "credit_ledger"("seq");
CREATE INDEX "credit_ledger_ref_id_idx" ON "credit_ledger"("ref_id");

-- jobs: the web + sweeper look jobs up by payload entity ids constantly
CREATE INDEX "jobs_payload_project_idx" ON "jobs" ((payload->>'projectId'));
CREATE INDEX "jobs_payload_asset_idx" ON "jobs" ((payload->>'assetId'));
CREATE INDEX "jobs_payload_export_idx" ON "jobs" ((payload->>'exportId'));
CREATE INDEX "jobs_finished_at_idx" ON "jobs"("finished_at");

-- generations: money-adjacent value gets exact decimal, not float
ALTER TABLE "generations" ALTER COLUMN "vendor_cost_usd" TYPE DECIMAL(10,4);

-- music_tracks: per-beat RMS energy for the slot planner (§6.4.3)
ALTER TABLE "music_tracks" ADD COLUMN "energy" JSONB;
