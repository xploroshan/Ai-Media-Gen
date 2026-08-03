# ReelForge v1 — Deployment Guide

> Companion documents: [ARCHITECTURE.md](./ARCHITECTURE.md) · [FLOWCHARTS.md](./FLOWCHARTS.md)
>
> **New to deploying?** Follow the click-by-click
> [DEPLOYMENT_WALKTHROUGH.md](./DEPLOYMENT_WALKTHROUGH.md) instead — this page
> is the condensed reference.

ReelForge deploys as **four pieces**: Postgres, an S3-compatible object store,
the **web** service (Next.js, stateless), and the **worker** service (Python,
CPU-heavy). Web and worker share only `DATABASE_URL` and the `S3_*` settings —
there is no network path between them.

## 1. Environment reference

Both services validate env at boot and fail fast (web: zod in
`apps/web/src/lib/env.ts`; worker: pydantic in `worker/lib/settings.py`).

| Variable                                                        | Used by      | Required | Notes                                                                                                                                   |
| --------------------------------------------------------------- | ------------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                                  | web + worker | yes      | Postgres 16+. Prisma migrates; worker only reads/writes.                                                                                |
| `S3_ENDPOINT` / `S3_ACCESS_KEY` / `S3_SECRET_KEY` / `S3_REGION` | web + worker | yes      | Any S3 API (MinIO, R2, S3). Path-style addressing is used.                                                                              |
| `S3_BUCKET_ORIGINALS/_DERIVED/_RENDERS/_GENERATED`              | web + worker | yes      | Four buckets must exist (originals, derived, renders, generated).                                                                       |
| `AUTH_SECRET`                                                   | web          | yes      | ≥32 chars; better-auth session signing.                                                                                                 |
| `APP_URL`                                                       | web          | yes      | Public base URL (OTP links, auth callbacks).                                                                                            |
| `RESEND_API_KEY`                                                | web          | no       | Absent ⇒ dev mode: OTP is logged to the server console and the dev-only `GET /api/dev/last-otp` route is enabled. Set it in production. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`                     | web          | no       | Google login button hidden when unset.                                                                                                  |
| `FAL_KEY`                                                       | web + worker | no       | Absent ⇒ `StubProvider` for all AI generation (dev/CI default). Set to enable fal.ai.                                                   |
| `WORKER_CONCURRENCY`                                            | worker       | no (2)   | Poller slots. With ≥2, slot 0 is reserved for render jobs.                                                                              |
| `MODEL_CACHE_DIR`                                               | worker       | no       | Defaults to `/models` (weights baked into the image).                                                                                   |

`.env.example` at the repo root stays current — copy it to `.env` for local dev.

## 2. Local development

```bash
pnpm install                                          # root (pnpm 10 workspace)
docker compose -f infra/docker-compose.dev.yml up -d  # postgres + minio (+ bucket init) + worker
pnpm db:migrate && pnpm seed                          # schema + vibes/presets/models/demo user
pnpm dev                                              # web on http://localhost:3000
```

The dev compose stack:

- **postgres:16-alpine** on `:5432` (`reelforge`/`reelforge`), volume-backed.
- **minio** on `:9000` (console `:9001`), plus a one-shot `minio-init` that
  creates the four buckets.
- **worker** built from `services/worker/Dockerfile`, healthcheck on
  `:8001/healthz`. The `worker/` package directory is **volume-mounted for
  live reload — restart the container to pick up code changes; rebuild the
  image only when dependencies change**. Model weights live in the image at
  `/models` (deliberately _not_ volume-mounted).

Seeded demo user: `demo@reelforge.local` (admin). Without `RESEND_API_KEY`,
sign-in OTPs print to the `pnpm dev` console.

## 3. Testing

```bash
bash scripts/make_fixtures.sh        # synthetic media (required once before e2e)
pnpm test                            # vitest (shared schema + editor ops)
pnpm --filter web typecheck && pnpm lint
docker compose -f infra/docker-compose.dev.yml exec worker python -m pytest  # worker suite
pnpm e2e                             # Playwright, StubProvider, against the compose stack
RUN_LIVE_AI=1 FAL_KEY=... pytest -k live   # optional live fal smoke — NEVER in CI
```

Playwright launches `pnpm dev` itself (webServer config). In environments with
a pre-installed Chromium, point at it: `PW_CHROMIUM_PATH=/opt/pw-browsers/chromium pnpm e2e`.
CI (`.github/workflows/ci.yml`) runs lint → typecheck → unit → e2e with the
stub provider and zero external AI calls.

## 4. Production builds

- **web** — `apps/web/Dockerfile`: multi-stage pnpm build → Next.js
  **standalone** output; runs `node server.js` as non-root on `:3000`.
  Production builds disable the dev OTP route.
- **worker** — `services/worker/Dockerfile`: python:3.12-slim + ffmpeg +
  fonts; ML deps installed in layered requirements (CPU-only torch wheels;
  basicsr/realesrgan/simple-lama installed `--no-deps` with an explicit dep
  list + a `functional_tensor` shim); **all model weights are pre-fetched at
  build time into `/models`** (CLIP ViT-B/32, BlazeFace, faster-whisper small
  int8, rembg isnet-general, LaMa, RealESRGAN x2plus) so the container needs no
  model downloads at runtime. Healthcheck: `GET :8001/healthz`.

## 5. Deploying to Railway (SPEC §11.3)

One Railway project, four services:

1. **Postgres** — Railway plugin; copy its URL to `DATABASE_URL`.
   (pgvector optional — CLIP embeddings are JSONB by default, DECISIONS #4.)
2. **Object storage** — MinIO template with a volume, or any S3-compatible
   store (only the S3 API is assumed). Set the `S3_*` vars and create the four
   buckets.
3. **web** — deploy from `apps/web/Dockerfile`. Set env per the table above.
   After the first deploy run once (one-off command):
   `pnpm db:migrate && pnpm seed`.
4. **worker** — deploy from `services/worker/Dockerfile` with the same
   `DATABASE_URL` + `S3_*` (+ optional `FAL_KEY`), `WORKER_CONCURRENCY=2`.

No IaC is required for v1. Payments are stubbed (`PaymentsProvider` +
`/api/webhooks/razorpay` Razorpay stub): plans are toggled from the admin page.

### Before going live

- Set `RESEND_API_KEY` (real OTP email) and a strong `AUTH_SECRET`.
- **Verify fal model slugs**: the seeded slugs are SPEC placeholders that could
  not be live-verified from the build environment (DECISIONS #8). Run the live
  smoke (`RUN_LIVE_AI=1` + `FAL_KEY`) and correct slugs in **Admin → Models**.
- Point `APP_URL` at the public domain; add it to Google OAuth redirect URIs
  if Google login is enabled.

## 6. Scaling & capacity

- **web** is stateless — scale horizontally at will. Sessions are DB-backed.
- **worker** renders are CPU-real: prefer **vertical** scaling first
  (SPEC §13 targets on ~4 vCPU: 20 s preview ≈ ≤2 min; 30 s 1080p final ≈
  ≤6 min). Horizontal worker scaling is safe by construction: claims use
  `FOR UPDATE SKIP LOCKED`, every job mutation is lease-guarded, and the
  sweeper/reconciler are idempotent across replicas.
- The render slot reservation (slot 0) keeps previews responsive while
  analysis/generation jobs run on the other slots.
- Whisper/CLIP/LaMa/ESRGAN are CPU-inference; memory footprint is dominated by
  the models (~2–3 GB RSS worst case) — size worker instances ≥4 GB RAM.

## 7. Operations runbook

- **Health**: worker `GET :8001/healthz` returns uptime + registered handlers;
  web is healthy if it serves `/login`. Watch `jobs` for rows with
  `status='failed'` and for `attempts=3` terminal failures.
- **Stuck entities repair themselves**: the sweeper re-queues stale running
  jobs (5 min heartbeat), fails exhausted ones, refunds orphaned generations,
  and reconciles projects/exports/assets stranded by dead jobs (10 min grace).
  If something looks wedged, check the worker logs before touching rows.
- **Credits audit**: replaying `credit_ledger` by `seq` must equal
  `profiles.credits_balance` per owner (worker
  `credits.replay_ledger_balance`); any mismatch is a defect.
- **Job pruning** (ops note, not automated in v1):
  `DELETE FROM jobs WHERE finished_at < now() - interval '30 days';`
  (`finished_at` is indexed).
- **Backups**: Postgres is the source of truth for everything except media
  bytes; back up the DB and the four buckets. Originals are immutable — every
  transform writes a new derived object.
- **Migrations**: `pnpm db:migrate` (Prisma migrate deploy) — run from the web
  service; the worker never migrates. Migrations are additive so far; the
  worker tolerates unknown columns.
- **Logs**: worker logs one line per job transition (`start/done/failed →
queued|failed|lost`), sweeper actions, and full tracebacks on failure. Web
  logs unhandled route errors via the `withApi` wrapper.
