# REVIEW.md — ultra-review record (CLAUDE.md §5)

**Final verification (post-fix, official gate):** full Playwright E2E suite
(17 tests, StubProvider, compose stack) green **3× consecutively** on the final
code — 17/17 in 8.8 m, 17/17 in 4.7 m, 17/17 in 5.0 m. Worker pytest: 111
passed / 1 skipped (live-fal smoke, env-gated). Vitest: 20 passed. Typecheck,
lint, and production builds (`pnpm build`, worker image) clean.

Adversarial multi-lens review of the full ReelForge v1 implementation
(everything on `claude/validate-plan-build-isexe0`: `apps/web`, `services/worker`,
`packages/shared`, `e2e`, `scripts`, `infra`), run after P0–P8 completed and the
full E2E suite passed. Eight independent review lenses (correctness, security,
concurrency, data integrity/credits, error handling, performance, API contract,
test coverage) each swept the codebase; candidate findings were deduplicated and
adversarially verified before fixing. **Every confirmed finding below is fixed**
(commit `fix: apply ultra-review findings across worker and web` and the
follow-up test-hardening commit); waivers are listed at the end with rationale.

## Confirmed findings and fixes

### Security
- **Cross-tenant asset reads via edit-spec** (high) — `PATCH /projects/:id`
  accepted specs referencing other users' asset ids; the renderer would then
  download them. Fixed: PATCH validates every referenced asset is owned by the
  caller (or a seeded music track) → 403 `forbidden_asset`; worker render and
  autoedit queries filter by project-owner as defense in depth; project creation
  filters candidate ids to owned+ready; `/projects/:id/assets` and the music
  lookup apply owned-or-seed filters; `GET /jobs/:id` no longer exposes
  owner-less jobs.

### Concurrency / queue integrity
- **Job mutations ignored the lease** (high) — a worker that lost its lease
  (stale-heartbeat sweep) could still mark the job done/failed and clobber the
  reclaiming worker. Fixed: `heartbeat/complete_job/fail_job/update_progress`
  are all guarded by `WHERE status='running' AND locked_by=:worker`; callers
  handle the "lost" outcome; graceful shutdown re-queues own running jobs
  without burning an attempt.
- **Sweeper repaired jobs but not entities** (high) — a terminally-failed job
  left its project stuck `rendering`, its export stuck `queued`, its asset stuck
  `analyzing` forever. Fixed: `worker/lib/reconcile.py` runs from the sweeper
  and repairs all three (grace period + no-live-job guard).
- **Autoedit/shuffle races** (medium) — two shuffles (or a shuffle racing a
  manual PATCH) could interleave. Fixed: shuffle/PATCH return 409 while an
  autoedit job is queued/running, and the worker's final project UPDATE is
  guarded by `seed` equality so a superseded plan aborts without enqueuing a
  render.
- **detect_events double-enqueue** (medium) — two analyze jobs finishing
  together both saw "no pending job". Fixed: per-owner
  `pg_advisory_xact_lock` around check+insert in one transaction.
- **Monthly grant double-apply** (medium) — the granted-this-month check ran
  before the profile row lock. Fixed: lock first, then check.
- **Upload complete / best-of-2 pick double-submit** (medium) — fixed with
  atomic `updateMany` claims (`uploading→analyzing`, `resultAssetId NULL→set`),
  409 for the loser.

### Data integrity (credits ledger)
- **Refund idempotency was reason-scoped** (high) — a `partial_refund` row did
  not block a later full `refund`, allowing over-refund. Fixed: idempotency is
  any positive-delta ledger row for the generation; `refund_generation` also
  refuses `status='done'` rows outright.
- **Reconciler pre-flipped status outside the refund tx** (medium) — a crash
  between the flip and the refund left a `failed` row holding credits and
  invisible to a re-scan. Fixed: single-transaction settle per row inside
  `refund_generation`; the sweeper query keys off "no positive-delta ledger
  row", so it always re-finds unsettled rows.
- **Best-of-2 partial delivery kept full price** (high) — one failed take out
  of two still charged for both. Fixed: per-take checkpointing in
  `generations.params` (same tx as asset creation, guarded by
  `status='running'`), retry resumes only missing takes, and the terminal
  partial delivery refunds `per-take cost × missing takes` in the same tx that
  flips to `done` (ledger row `partial_refund`, `credit_cost` reduced).
- **generate_ai raced the reconciler** (high) — a handler finishing after the
  sweeper refunded its generation would overwrite `refunded` with `done`
  (results + refund both kept). Fixed: every status transition is guarded
  (`queued/running→running`, `running→done`); rowcount 0 = superseded, results
  are not delivered and no analyze jobs are enqueued.
- **Ledger replay order** (low) — replay ordered by `created_at,id`, which ties
  in the same millisecond. Fixed: `seq BIGSERIAL` column; replay orders by it.
- **vendor_cost_usd** (low) — was Float and hardcoded 0. Fixed: Decimal(10,4),
  summed from `GenResult.cost_usd`, NULL when the provider doesn't report.

### Error handling / resilience
- **ffmpeg stderr deadlock** (high) — `run_render` read only stdout; a chatty
  ffmpeg fills the stderr pipe and both processes hang forever. Fixed: stderr
  drain thread (bounded tail), watchdog hard timeout (30 min), kill+wait in
  `finally`.
- **Renderer main-body material shortfall** (high) — a source shorter than its
  slot produced fewer frames than the xfade offsets assumed, desyncing every
  later boundary. Fixed: pad computation now covers any source shortfall
  (main body and transition tail) with cloned-frame `tpad`.
- **Partial analysis lost on failure** (medium, SPEC §6.1.8) — analyzers built
  results locally and a mid-pipeline exception discarded everything. Fixed:
  analyzers accumulate into shared dicts; the failure path persists whatever
  was computed before marking `failed`; download included in the try scope.
- **Export failed on non-terminal attempt** (medium) — `render_final`'s first
  transient failure marked the export `failed` while retries were still
  scheduled. Fixed: only the terminal attempt (or the sweeper reconciler)
  fails it.
- **Temp-file leaks** (low) — render sources/music leaked on exception;
  `download_to_tmp` leaked on failed download. Fixed with `finally` cleanup.
- **Client resilience** (medium) — editor autosave now catches network
  failures, retries every 5 s while dirty, and warns on tab close; the three
  job-poll loops (export, transcribe, image ops) tolerate up to 5 transient
  poll failures instead of aborting a long render on one blip; multipart
  upload failures abort the upload server-side (`DELETE /api/media/:id`).
- **Error envelope** (medium) — unhandled route errors returned Next's default
  500 HTML. Fixed: `withApi` wrapper on all 27 API routes (ZodError → 400
  envelope, anything else → logged 500 envelope).

### Correctness
- **`updateClip` speed change left duration/srcOut stale** (high) — changing
  speed in the properties panel silently desynced timeline duration from the
  source span. Fixed: duration recomputed from the span at the new speed
  (unit-tested).
- **Beat grid ended with the music** (medium) — targets longer than the track
  left later cuts snapping to nothing. Fixed: the planner extrapolates the
  grid at the median beat interval to cover the timeline.
- **Energy curve was hardcoded None** (medium) — §6.4.3's energy-adaptive slot
  pacing never activated. Fixed: the beats job computes peak-normalized per-beat
  RMS into `music_tracks.energy`; the autoedit handler feeds it to the planner.
- **Karaoke `\k` ignored inter-word gaps** (medium) — highlighting drifted
  early on any silence. Fixed: `{\k gap}` filler tags between words (golden
  snapshots updated, en + hi).
- **taken_at timezone mix** (medium) — video creation_time (aware UTC) vs EXIF
  (naive local) crashes datetime comparison in clustering. Fixed: videos
  normalize to naive UTC (DECISIONS #12).
- **Event re-clustering left stale members** (low) — shrinking an event never
  cleared `event_id` on dropped assets; overlap lookup was non-deterministic.
  Fixed: detach-on-upsert + `ORDER BY start_at, id`.

### Performance
- **Motion sampling seek-per-frame** (medium) — `CAP_PROP_POS_MSEC` re-decodes
  from the previous keyframe per sample. Fixed: sequential `grab()` with frame
  skipping.
- **Image-op model reloads** (medium) — rembg/LaMa/Real-ESRGAN loaded per job.
  Fixed: lock-guarded process-lifetime singletons.
- **N+1 lookups** (medium) — events route (cover per event) and generations
  route (asset/track per result) now batch per page; events bounded to 200.
- **Missing indexes** (medium) — expression indexes on
  `jobs(payload->>'projectId'/'assetId'/'exportId')`, `jobs(finished_at)`,
  `credit_ledger(ref_id)` (hardening migration).
- **zoompan 2x supersample** (low) — capped at 1.5x (no visible gain at 1080p).
- **`bytes` overflow** (low) — zod max was 2 GiB, one over int4; now
  2 147 483 647.

### API contract
- **Export mutability** (medium) — finals rendered the *live* project spec, so
  edits during a final render leaked into the export. Fixed: export enqueues an
  `editSpecSnapshot` in the job payload; the worker renders the snapshot.
- **Audio track shape** (low) — the renderer reads only `clips[0]`; the schema
  now enforces `max(1)` so extra clips can't be silently dropped.
- **`bestOf2` placement** (low) — accepted top-level as well as in `params`.

### Test coverage (hardening applied)
- Queue tests: unique per-test job types (no cross-run races), lease-loss
  cases (complete/fail/heartbeat by a non-holder), `requeue_own_running`.
- Credits: refuse-done refund, cross-reason idempotency, 4-thread concurrent
  refund applies exactly once.
- Autoedit: beat-sync property parametrized over seeds AND jittered
  (librosa-like) grids; shuffle floor over 3 seed pairs; dedupe adjacency
  asserts at near-dupe-cluster level.
- Renderer: golden tests for main-body + tail pad; .ass gap-filler goldens
  (en + hi full snapshots).
- E2E: p1 thumbs via `expect.poll` + tolerant banner observation; p3/p4 wait
  for the render to *start* then assert the preview object key changed; p6
  bg-remove checks real alpha (transparent corners, opaque center) and erase
  checks a pixel diff in the painted region + derived assets reach `ready`;
  p7 free export duration upper bound.

## Waived findings (accepted, with rationale)

1. **Dev OTP endpoint** (`/api/dev/last-otp`) — test/dev-only credential
   surface. Gated: 404 in production builds and whenever `RESEND_API_KEY` is
   set (DECISIONS #5). Waived as a deliberate dev affordance.
2. **Safety blocklist is keyword-based** — `MODERATION-HOOK` marks the real
   moderation integration point per SPEC §8.5; a keyword list is trivially
   bypassable but is the specced v1 scope.
3. **md5-based ids in worker SQL inserts** — `substr(md5(random()...))` ids are
   not cryptographically unique like cuid, but collision probability at v1
   scale is negligible and every insert is single-row inside a tx (a collision
   fails loudly on the PK). Waived; noted for a future shared id helper.
4. **Job-row growth / pruning** — done/failed jobs accumulate indefinitely.
   Ops note: prune `jobs WHERE finished_at < now() - interval '30 days'`
   (index on `finished_at` added). No automatic pruning in v1.
5. **`transform` is render-inert** — round-trips but does not alter the
   filtergraph (DECISIONS #10). The properties panel exposes only honored
   controls.
6. **GenProvider blocks a worker slot for up to 10 min** — accepted v1 design
   (DECISIONS #13); render jobs have a dedicated slot so previews stay live.
7. **Preview render uses the live spec** — previews are ephemeral by design;
   only finals snapshot (finding above). Waived for previews.
8. **fal slug placeholders unverified** — environment returns HTTP 429 to
   fal.ai (DECISIONS #8); slugs are admin-editable data, stub provider default,
   live smoke available behind `RUN_LIVE_AI=1`.
9. **Erase alpha-vs-luma mask contract** — an all-opaque RGBA mask erases the
   whole image by contract (alpha wins whenever it carries signal); the web
   canvas always sends painted-alpha masks. Unit test documents the contract.
