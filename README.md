# ReelForge

Turn your photos and videos into beat-synced social reels: auto-edit engine,
timeline editor, captions (English + हिन्दी), AI studio (via fal.ai), image
cleanup tools, and platform-preset exports — as a web app (PWA).

Built to `SPEC.md` (the single source of truth). Design decisions made where
the spec was ambiguous are logged in `DECISIONS.md`; post-build review findings
in `REVIEW.md`.

## Quickstart (local dev, ≤15 min on a fresh clone)

Prerequisites: Node 22 + pnpm 10, Docker + Compose, Python 3.11+ (host tooling),
`ffmpeg` + `espeak-ng` on the PATH (for test fixtures).

```bash
pnpm install                                          # JS workspaces
cp .env.example apps/web/.env                         # defaults match dev compose
docker compose -f infra/docker-compose.dev.yml up -d  # postgres + minio + worker
                                                      # (first build downloads models, ~10 min)
pnpm db:migrate && pnpm seed                          # schema + vibes/presets/models/demo user
bash scripts/make_fixtures.sh                         # synthetic test media (required before e2e)
pnpm dev                                              # web on http://localhost:3000
```

Sign in with any email — in dev mode the OTP code is printed to the `pnpm dev`
console. The seeded admin is `demo@reelforge.local`.

**Demo flow** (the seeded happy path): Library → Upload the files from
`e2e/fixtures/` → wait for analysis → an event chip appears → Create → pick the
event → Travel Cinematic → Reel → Create my reel → watch the preview → Shuffle
or open the editor → Export (free plan = 720p + watermark).

## Tests

```bash
pnpm test                            # vitest (shared contracts + editor ops)
pnpm --filter web typecheck && pnpm lint
cd services/worker && .venv/bin/pytest          # worker unit + integration (needs compose up)
pnpm e2e                             # Playwright, StubProvider only — zero external AI calls
```

CI (`.github/workflows/ci.yml`) runs lint → typecheck → unit (vitest+pytest) →
e2e, always against the stub AI provider.

- The e2e suite drives the real pipeline: uploads, CPU analysis (CLIP, scene
  detection, faces, beats), auto-edit, FFmpeg renders verified with ffprobe,
  credits ledger, image ops.
- `RUN_LIVE_AI=1 FAL_KEY=... pytest -k live_fal` runs the one live fal.ai smoke
  test (never in CI).

## Architecture (SPEC §1)

- `apps/web` — Next.js 15 (App Router) + better-auth (email OTP + optional
  Google) + Prisma (owns the schema/migrations). All client traffic goes
  through `/api/*`.
- `services/worker` — Python 3.12 container: FastAPI `/healthz` + a Postgres
  `FOR UPDATE SKIP LOCKED` job queue (no Redis, no web↔worker HTTP). Media
  analysis, auto-edit planning, FFmpeg rendering, faster-whisper transcription,
  image ops, and AI generation (fal.ai or the built-in stub).
- `packages/shared` — the edit-spec JSON contract (zod, §5.1) + job payloads.
  The edit-spec is the *only* representation of an edit anywhere.
- Postgres + MinIO (S3 API) — buckets `originals`, `derived`, `renders`,
  `generated`.

## AI generation

All generative AI goes through the `GenProvider` interface. Without `FAL_KEY`,
the `StubProvider` produces deterministic local fixtures (dev/CI default). With
`FAL_KEY`, `FalProvider` calls fal.ai's queue API. Model slugs live in the
`gen_models` table (admin-editable at `/admin`) — **verify the seeded slugs
against the live fal catalog before production** (see `DECISIONS.md` #8).
Credits are ledger-based and transactional; every spend/refund is a ledger row
and replaying the ledger always equals the balance.

## Deploying to Railway (SPEC §11.3)

Create one Railway project with four services:

1. **Postgres** — Railway plugin. Copy its URL into `DATABASE_URL`.
   (pgvector optional; the app stores CLIP embeddings as JSONB by default.)
2. **MinIO** — Railway template with a volume, or any S3-compatible store; the
   code only assumes the S3 API. Set `S3_ENDPOINT/S3_ACCESS_KEY/S3_SECRET_KEY`
   and create buckets `originals`, `derived`, `renders`, `generated`.
3. **web** — deploy from `apps/web/Dockerfile` (Next standalone). Env per
   `.env.example` (`DATABASE_URL`, `S3_*`, `AUTH_SECRET`, `APP_URL`, optional
   `RESEND_API_KEY` for real OTP email, optional `GOOGLE_CLIENT_ID/SECRET`,
   optional `FAL_KEY`). Run `pnpm db:migrate && pnpm seed` once (Railway
   one-off command) after the first deploy.
4. **worker** — deploy from `services/worker/Dockerfile`. Same `DATABASE_URL` +
   `S3_*` + optional `FAL_KEY`; `WORKER_CONCURRENCY=2`. Renders are CPU-real:
   pick a high-CPU plan and scale vertically first. Expected times on ~4 vCPU:
   20 s preview ≈ ≤2 min, 30 s 1080p final ≈ ≤6 min (SPEC §13).

No IaC is required for v1. Payments are stubbed (`PaymentsProvider` +
`/api/webhooks/razorpay` TODO): plans are toggled from the admin page.

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — system design, contracts, data model, queue, pipelines
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) — env reference, local dev, production (Railway), scaling, ops runbook
- [docs/FLOWCHARTS.md](docs/FLOWCHARTS.md) — Mermaid flow charts for every major flow
- [SPEC.md](SPEC.md) — the authoritative product spec · [DECISIONS.md](DECISIONS.md) · [REVIEW.md](REVIEW.md)

## Repo map

```
apps/web            Next.js app (UI + API routes + Prisma schema)
services/worker     Python worker (queue, pipelines, renderer, providers)
packages/shared     edit-spec + job payload contracts (zod)
e2e                 Playwright suite + generated fixtures
scripts             fixture + seed-music generators
infra               docker-compose dev stack
```
