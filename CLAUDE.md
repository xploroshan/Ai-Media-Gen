# CLAUDE.md — ReelForge working agreement

## What this project is
ReelForge v1: web app (PWA) that turns user photos/videos into beat-synced social videos (auto-edit engine), with a timeline editor, image cleanup tools, and AI generation via **fal.ai only** — nothing self-hosted beyond CPU-light OSS tooling. **SPEC.md is the single source of truth.** If code and SPEC.md disagree, SPEC.md wins; if SPEC.md is ambiguous, choose the simplest option consistent with its architecture and record the choice in `DECISIONS.md`.

## Build agreement (owner's standing instructions)
1. Execute SPEC.md **phases P0→P8 in order**. Do not skip ahead; do not start a phase before the previous phase's exit tests pass in CI.
2. Write the phase's tests **in the same phase**, run them, fix failures. A phase is done only when its exit tests are green.
3. **Do not stop to ask permission** while work proceeds according to SPEC.md. Ask only when a genuine deviation from the spec is required — state the deviation, reason, and chosen alternative, then continue.
4. If a usage limit interrupts work, resume automatically where you left off when it lifts.
5. After P8: run the full E2E suite until green 3× consecutively, then perform an exhaustive adversarial code review (ultra-review) across correctness, security, concurrency, data integrity (credits ledger!), error handling, and performance. **Fix everything found.** Only then report completion, with a summary of what was built, test results, and any waived findings in `REVIEW.md`.
6. Never mark the project done with failing tests, partial phases, or unresolved review findings.

## Guardrails
- **Licenses**: only add dependencies matching SPEC.md §12 license classes. Never add: CC-BY-NC model weights, AGPL libraries, CodeFormer, InsightFace models, MMAudio, MusicGen.
- **No self-hosted big models.** Generative AI goes through the `GenProvider` interface. `StubProvider` is the default; `FalProvider` activates only when `FAL_KEY` is set. CI must never make external AI calls.
- **fal.ai model slugs in SPEC §8.2 are placeholders** — verify each against the live fal catalog before wiring, and keep slugs in the `gen_models` table, never hardcoded.
- **Edit-spec JSON (SPEC §5.1) is the only representation of an edit.** Editor and renderer both consume it. Never invent a parallel format.
- Credits are ledger-based and transactional (SPEC §8.4). Any code path that can spend without a ledger row is a defect.
- Originals are immutable — every transform creates a new derived asset.
- No secrets in git. `.env.example` stays current. Validate env at boot; fail fast.
- Sanctioned TODO markers only: `QC-HOOK`, `LLM-HOOK`, `MODERATION-HOOK`, `C2PA-HOOK`, Razorpay stub.

## Commands
```bash
pnpm install                       # root
docker compose -f infra/docker-compose.dev.yml up -d   # pg + minio + worker
pnpm dev                           # web on :3000
pnpm db:migrate && pnpm seed       # schema + vibes/presets/models/demo user
bash scripts/make_fixtures.sh      # synthetic test media (required before e2e)
pnpm test                          # vitest unit
pnpm --filter web typecheck && pnpm lint
cd services/worker && pytest       # worker unit/property tests
pnpm e2e                           # Playwright (stub providers)
```

## Conventions
- TypeScript strict; no `any`; zod at every API boundary; errors as `{error:{code,message}}`.
- Python: ruff-clean, type hints, small pure functions in `worker/lib/` with pytest coverage; job handlers thin.
- DB naming snake_case via Prisma `@map`; Prisma owns migrations — worker never migrates.
- Conventional commits (`feat:`, `fix:`, `test:`, `chore:`); commit at least once per completed phase step.
- UI: shadcn/ui components, mobile-responsive, loading/empty/error states for every async view.
