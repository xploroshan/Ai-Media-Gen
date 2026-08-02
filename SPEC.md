# SPEC.md — ReelForge v1 Build Specification

**For execution by Claude Code. Read fully before writing any code. CLAUDE.md contains the working agreement; this file contains everything to build.**

| | |
|---|---|
| Version | 1.0 — 2 Aug 2026 |
| Product | ReelForge: turn user photos/videos into polished social videos (auto-edit engine) + AI generation via external APIs |
| Target | **Web app (PWA) + API + background workers.** No native mobile in this build. |
| Hosting | **Railway** (all services) — web, worker, Postgres, MinIO |
| Hard rule | **No self-hosted large AI models.** All generative AI through fal.ai (with a stub provider for dev/CI). Only CPU-light OSS tooling runs in our containers (FFmpeg, sharp, rembg, PySceneDetect, librosa, faster-whisper-small, CLIP ViT-B/32, IOPaint/LaMa, Real-ESRGAN). |
| License rule | Every dependency must be commercially safe (MIT/Apache/BSD/LGPL-dynamic). The register in §12 is the allowlist; **do not add deps with non-commercial weights (MMAudio, MusicGen, CodeFormer, InsightFace models, FLUX [dev]) or AGPL code (A1111, Essentia)**. |

## 0. Scope

### 0.1 In scope (phases P0–P8)
1. Auth (email OTP + Google), profiles, plans (feature-flag stub — no live payments)
2. Media library: chunked upload, CPU analysis pipeline (metadata, thumbs, proxies, quality scoring, scene detection, CLIP tags, near-dupe detection, event clustering), search
3. **Auto-Edit engine**: media + Vibe + platform preset → beat-synced edit → server-rendered video (the flagship)
4. Timeline editor (tracks, trim, text, captions, music, re-render)
5. Captions via faster-whisper (English + Hindi), styled, burned at render
6. AI Studio via **fal.ai**: text→image, image→video, text→video, TTS, music generation — credit-metered, all outputs tagged `synthetic=true`
7. Image studio: enhance, background remove, object erase, upscale
8. Export presets (Reel/Short/Story/Square/16:9), watermark on free plan, download + Web Share API
9. Admin page: job dashboard, feature flags, model routing table, credit adjustments

### 0.2 Explicitly OUT of scope (do not build, do not stub beyond noted interfaces)
- Native Android/iOS apps (later spec, same API)
- Direct Instagram/YouTube API publishing & scheduling (needs Meta/Google app review — export+share only)
- Live payments (build `PaymentsProvider` interface + admin plan override; Razorpay adapter = TODO stub)
- Team workspaces/roles/approvals; community templates
- Face *recognition/clustering* (license-encumbered; face *detection* for scoring is in)
- C2PA signing (leave `// C2PA-HOOK` comment at export finalization)
- Self-hosted big models of any kind

## 1. Architecture

```
┌───────────────────────────── Railway project ─────────────────────────────┐
│                                                                            │
│  apps/web (Next.js 15, standalone Docker)                                  │
│   ├─ UI (App Router, React 19, Tailwind, shadcn/ui, Zustand)               │
│   ├─ API route handlers (/api/*) — all client traffic                      │
│   └─ better-auth (email OTP + Google), Prisma → Postgres                   │
│                                                                            │
│  services/worker (Python 3.12 Docker: FastAPI /healthz + poller loop)      │
│   ├─ claims jobs from Postgres (FOR UPDATE SKIP LOCKED)                    │
│   ├─ media analysis · auto-edit planning · FFmpeg rendering                │
│   ├─ image cleanup (rembg, IOPaint/LaMa, Real-ESRGAN) · faster-whisper     │
│   └─ fal.ai calls for generation jobs (httpx)                              │
│                                                                            │
│  Postgres (Railway managed; pgvector extension if available, else JSONB)   │
│  MinIO (Railway template + volume; S3 API)                                 │
└────────────────────────────────────────────────────────────────────────────┘
External: fal.ai (all generative AI) · Resend (OTP email, prod only)
```

**Communication rules:**
- Client ↔ web API only (JSON, zod-validated). Client never talks to worker or MinIO directly *except* presigned upload/download URLs.
- Web ↔ worker **only via the `jobs` table** (no HTTP between them). Job progress read by client via polling `GET /api/jobs/:id` every 2 s while active (SSE optional later; do not build WebSockets).
- One schema owner: **Prisma migrations**. Worker reads the same DB via SQLAlchemy Core against the Prisma-created tables (snake_case mapping below).

## 2. Repository Layout (pnpm monorepo)

```
reelforge/
├── CLAUDE.md                  # working agreement (provided)
├── SPEC.md                    # this file
├── package.json  pnpm-workspace.yaml  turbo.json
├── apps/web/                  # Next.js 15 + TS strict
│   ├── src/app/(auth)/…       # login/otp pages
│   ├── src/app/(app)/library|create|editor/[projectId]|studio|images|settings|admin
│   ├── src/app/api/…          # route handlers
│   ├── src/components/…       # ui/, timeline/, wizard/, player/
│   ├── src/lib/               # auth.ts, db.ts, storage.ts, credits.ts, editspec/
│   └── prisma/schema.prisma   # single source of DB truth
├── services/worker/
│   ├── worker/__main__.py     # poller entry
│   ├── worker/jobs/           # analyze_media.py, autoedit.py, render.py, transcribe.py,
│   │                          # generate_ai.py, image_ops.py, beats.py, events.py
│   ├── worker/lib/            # db.py, s3.py, ffmpeg.py, editspec.py, scoring.py, fal.py
│   ├── worker/tests/          # pytest
│   └── Dockerfile             # python:3.12-slim + ffmpeg + fonts-noto (+Devanagari)
├── packages/shared/           # editspec JSON schema + zod types + TS API client types
├── e2e/                       # Playwright specs + fixtures/ (synthetic, generated by script)
├── scripts/make_fixtures.sh   # ffmpeg/ImageMagick synthetic test media (no binary fixtures in git)
├── scripts/fetch_seed_music.py# downloads the CC0 seed tracks listed in assets/music/SOURCES.md
├── infra/docker-compose.dev.yml  # postgres + minio + worker (web runs `pnpm dev` on host)
└── .github/workflows/ci.yml   # lint → typecheck → unit (vitest+pytest) → e2e (stub providers)
```

## 3. Fixed Technology Choices (do not relitigate during build)

| Concern | Choice | Notes |
|---|---|---|
| Web | Next.js 15 + React + TypeScript strict + Tailwind + shadcn/ui + Zustand + SWR | PWA manifest + service worker (basic offline shell only) |
| Auth | **better-auth** (MIT): email OTP + Google OAuth (env-gated) | Dev mode prints OTP to console; prod sends via Resend |
| ORM | Prisma (web) · SQLAlchemy Core (worker, read/write, no second migration system) | snake_case DB names via `@@map`/`@map` |
| Queue | **Postgres jobs table, FOR UPDATE SKIP LOCKED** | No Redis. Heartbeat + stale-reclaim (§5.3) |
| Storage | MinIO (S3 API) — buckets `originals`, `derived`, `renders`, `generated` | Presigned PUT (multipart ≥64 MB) and GET |
| Video processing | FFmpeg 6+ CLI invoked from worker (`worker/lib/ffmpeg.py` builds filtergraphs) | No MLT in v1 — one engine only |
| Image ops | sharp (web, instant ops) · Pillow/OpenCV (worker) | |
| AI gateway | **fal.ai** via `GenProvider` interface; `StubProvider` default in dev/CI | §8. Model slugs live in DB table `gen_models`, seeded; **verify current fal slugs at build time** |
| Transcription | faster-whisper `small` int8, CPU, in worker | langs: en, hi |
| Fonts | Noto Sans + Noto Sans Devanagari (OFL) bundled in worker image | caption burn-in |
| Tests | vitest (TS unit) · pytest (worker) · Playwright (e2e) · ffprobe assertions for renders | CI must pass with StubProvider only, zero external calls |
| Lint/format | eslint + prettier (TS) · ruff (py) | pre-commit via husky |

## 4. Data Model (Prisma — authoritative; all tables snake_case in DB)

```prisma
model User        // managed by better-auth; extended via Profile
model Profile {
  id            String  @id            // = auth user id
  displayName   String?
  locale        String  @default("en") // "en" | "hi"
  personaHint   String?                // self|audience|business|client
  plan          String  @default("free") // free|creator|business (flag only, no billing)
  creditsBalance Int    @default(120)
  isAdmin       Boolean @default(false)
  createdAt     DateTime @default(now())
}

model MediaAsset {
  id          String   @id @default(cuid())
  ownerId     String
  kind        String   // image|video|audio
  status      String   // uploading|analyzing|ready|failed
  storageKey  String   // originals/<owner>/<id>.<ext>
  thumbKey    String?
  proxyKey    String?  // 540p h264 for video editor preview
  filename    String
  bytes       Int
  width       Int?     height Int?
  durationSec Float?   fps Float?
  takenAt     DateTime? gpsLat Float? gpsLng Float?
  phash       String?  // 64-bit hex perceptual hash (images + video keyframe)
  synthetic   Boolean  @default(false) // true for AI-generated
  eventId     String?
  createdAt   DateTime @default(now())
  @@index([ownerId, status]) @@index([ownerId, takenAt])
}

model MediaAnalysis {
  assetId       String @id
  qualityScore  Float?   // 0..1 (§6.2)
  blurVar       Float?  exposureScore Float?
  tags          Json?    // [{label, score}] top-8 from CLIP label set
  clipEmbedding Json?    // float[512]; use pgvector column instead if extension available
  facesCount    Int?     faceAreaRatio Float?
  sceneCuts     Json?    // video: [secs]
  highlights    Json?    // video: [{start,end,score}] top-5 (motion+audio energy)
  beatTimes     Json?    // audio: [secs] (librosa)
  transcript    Json?    // {lang, words:[{w,s,e}]}
}

model Event {   // auto-clustered "Goa Trip" groups
  id String @id @default(cuid())
  ownerId String  title String  startAt DateTime  endAt DateTime
  assetIds Json   // string[]
}

model Project {
  id         String @id @default(cuid())
  ownerId    String
  title      String @default("Untitled")
  aspect     String @default("9:16")   // 9:16|1:1|4:5|16:9
  vibeId     String?
  presetId   String?                    // platform preset
  editSpec   Json                       // §5 schema — the core artifact
  status     String @default("draft")   // draft|rendering|ready
  seed       Int    @default(0)         // auto-edit determinism + shuffle
  createdAt  DateTime @default(now())  updatedAt DateTime @updatedAt
}

model Job {
  id        String   @id @default(cuid())
  type      String   // analyze_media|detect_events|autoedit_generate|render_preview|
                     // render_final|transcribe|beats|generate_ai|image_op
  status    String   @default("queued") // queued|running|done|failed|canceled
  priority  Int      @default(5)        // 1 highest
  payload   Json
  result    Json?
  error     String?
  attempts  Int      @default(0)
  lockedBy  String?  lockedAt DateTime?
  ownerId   String?
  createdAt DateTime @default(now())   finishedAt DateTime?
  @@index([status, priority, createdAt])
}

model Generation {
  id           String @id @default(cuid())
  ownerId      String
  kind         String // t2i|i2v|t2v|tts|music
  providerId   String // fal|stub
  modelSlug    String
  prompt       String
  params       Json
  creditCost   Int
  status       String @default("queued") // queued|running|done|failed|refunded
  resultAssetId String?
  vendorCostUsd Float?
  jobId        String?
  createdAt    DateTime @default(now())
}

model CreditLedger {
  id        String @id @default(cuid())
  ownerId   String
  delta     Int      // negative = spend
  reason    String   // generation|refund|signup_bonus|admin_adjust
  refId     String?  // generation id etc.
  balanceAfter Int
  createdAt DateTime @default(now())
}

model Export {
  id        String @id @default(cuid())
  projectId String  ownerId String
  presetId  String  resolution String // 720p|1080p
  watermark Boolean
  storageKey String?
  status    String @default("queued")
  ffprobe   Json?   // verification snapshot
  createdAt DateTime @default(now())
}

model Vibe          { id String @id; name String; config Json; sortOrder Int }   // seeded (§6.3)
model PlatformPreset{ id String @id; name String; aspect String; maxSec Int; recSec Int; notes String? } // seeded from FRD PUB-02
model GenModel     { id String @id @default(cuid()); kind String; tier String; providerId String;
                     modelSlug String; creditPerUnit Int; unit String; active Boolean @default(true) } // routing table
model FeatureFlag  { key String @id; value Json }
model MusicTrack   { id String @id @default(cuid()); title String; storageKey String; durationSec Float;
                     beatTimes Json?; license String; attribution String? } // seeded CC0 set + user uploads
```

## 5. Core Contracts

### 5.1 Edit-Spec JSON (packages/shared — zod schema + JSON Schema export; version it)

```jsonc
{
  "version": 1,
  "aspect": "9:16", "width": 1080, "height": 1920, "fps": 30,
  "durationSec": 30.0,
  "tracks": [
    { "id": "v1", "type": "video", "clips": [
        { "id": "c1", "assetId": "…", "kind": "video|image",
          "timelineStart": 0.0, "duration": 2.4,          // seconds on timeline
          "srcIn": 12.2, "srcOut": 14.6,                   // video trim (ignored for image)
          "speed": 1.0,
          "transform": { "scale": 1.0, "x": 0, "y": 0, "rotate": 0 }, // 0,0 = centered cover-fit
          "kenBurns": { "fromScale": 1.05, "toScale": 1.18, "panX": 0.03, "panY": 0 }, // images only
          "transitionAfter": { "type": "cut|fade|slideleft|zoom", "duration": 0.3 }
        } ] },
    { "id": "t1", "type": "text", "clips": [
        { "id": "x1", "text": "Goa 2026", "start": 0.2, "end": 2.2,
          "styleId": "title-bold", "pos": "center|lower|upper", "animate": "pop|fade|none" } ] },
    { "id": "a1", "type": "audio", "clips": [
        { "id": "m1", "assetId": "…", "timelineStart": 0, "srcIn": 8.0, "gainDb": 0,
          "duckUnderSpeechDb": -10 } ] }
  ],
  "captions": { "enabled": true, "styleId": "karaoke-yellow", "lang": "en",
                "words": [ { "w": "hello", "s": 3.21, "e": 3.44 } ] },
  "color": { "lut": null, "brightness": 0, "contrast": 0, "saturation": 0 },
  "watermark": { "enabled": true },
  "meta": { "vibeId": "travel-cinematic", "seed": 42, "beatTimes": [0.51, 1.02] }
}
```
Rules: single video track in v1 (overlay track = P2); clips non-overlapping, sorted; renderer and editor must both consume this — **no other representation of an edit exists anywhere.**

### 5.2 Job payloads (zod in shared, mirrored in worker)
`analyze_media {assetId}` · `detect_events {ownerId}` · `beats {assetId}` · `transcribe {assetId, lang?}` · `autoedit_generate {projectId, assetIds[], vibeId, presetId, targetSec, seed, steering?{pace?,peopleBias?,fewerClips?}}` · `render_preview|render_final {projectId, exportId?}` (preview: 540p/CRF28/veryfast; final: per export) · `generate_ai {generationId}` · `image_op {assetId, op: enhance|bg_remove|erase|upscale, params{maskKey?}}`

### 5.3 Queue semantics (worker/lib/db.py)
- Claim: `UPDATE jobs SET status='running', locked_by=$w, locked_at=now(), attempts=attempts+1 WHERE id = (SELECT id FROM jobs WHERE status='queued' ORDER BY priority, created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`
- Heartbeat: update `locked_at` every 30 s from a thread. Reclaim: a sweeper re-queues `running` jobs with `locked_at < now()-'5 min'` and `attempts < 3`, else fails them.
- Failure: exponential retry (30 s, 2 min) to max 3 attempts → `failed` + human-readable `error`. `generate_ai` failures must refund credits atomically (§8.4).
- Concurrency: worker runs N=2 job slots (env `WORKER_CONCURRENCY`); render jobs take a dedicated slot.

### 5.4 API surface (all under /api, session-authenticated, zod-validated; errors as `{error:{code,message}}`)
```
POST /media/presign-upload {filename,bytes,kind} → {assetId, uploadUrl|multipart{...}}
POST /media/:id/complete            → enqueues analyze_media (+beats for audio)
GET  /media?query=&eventId=&page=   → library grid (tags/date filters)
GET  /events                        → clustered events
POST /projects {assetIds|eventId, vibeId, presetId, targetSec} → creates project + autoedit job
POST /projects/:id/shuffle {steering?} → new seed + autoedit job
PATCH /projects/:id {editSpec}      → validates zod, bumps version, enqueues render_preview (debounced client-side)
POST /projects/:id/export {presetId, resolution} → export + render_final job (checks plan for 1080p/watermark)
GET  /jobs/:id                      → {status, progress?, result?}
POST /generate {kind, tier, prompt, params, bestOf2?} → credit check → generation + job
GET  /generations?…                 → history
POST /images/:id/op {op, params}    → image_op job
GET/POST /admin/* (isAdmin)         → flags, gen_models CRUD, jobs dashboard, credit adjust
```

## 6. Pipeline Algorithms (worker) — implement exactly, tune constants later

### 6.1 Media analysis (`analyze_media`)
1. `ffprobe` → dims/duration/fps/codec; EXIF via Pillow (`takenAt`, GPS).
2. Thumbs: images → 512px JPEG; videos → frames at 10/50/90% (`derived/…/thumb_0.jpg` etc., first = cover). Videos also → 540p H.264 proxy (`-preset veryfast -crf 28 -movflags +faststart`).
3. Image quality: `blurVar` = variance of Laplacian (OpenCV, grayscale); `exposureScore` = 1 − clipped-histogram fraction (>2% pixels at 0 or 255 penalized). `qualityScore = clamp(0.5*norm(blurVar) + 0.3*exposureScore + 0.2*resolutionScore)`.
4. Video: PySceneDetect `ContentDetector(threshold=27)` → `sceneCuts`; per-scene middle frame → quality as above (asset score = mean of top-3 scenes); motion = mean abs frame-diff at 2 fps sample; audio RMS energy (librosa, 0.5 s hop) → `highlights` = top-5 windows of 1.5–4 s by `0.6*motion + 0.4*audioEnergy` (non-overlapping).
5. CLIP ViT-B/32 (open_clip, CPU) on cover frame → embedding; `tags` = top-8 cosine matches against the ~120-label set in `worker/lib/labels.py` (people/scene/activity/food/festival/product labels; include Indian-context labels: mehndi, haldi, diya, rangoli, cricket, temple…). Store embedding (pgvector if available else JSON).
6. Faces: MediaPipe face detection on cover frame → `facesCount`, `faceAreaRatio`. **No identity/recognition.**
7. `phash` via imagehash (cover frame for videos).
8. Set `ready`; on any step failure set `failed` with reason but keep partial analysis.

### 6.2 Event clustering (`detect_events`, batch after ≥10 new ready assets or on demand)
Sort by `takenAt`; break when gap > 4 h OR haversine > 25 km; keep clusters ≥ 6 assets; title = `"{Month D–D}"` (+ reverse-geo city if offline lookup lib available — else omit); upsert non-destructively.

### 6.3 Vibes (seed exactly these 3 in v1; config drives §6.4 + §7)
| id | pace (clip sec @ energy low/high) | transitions | caption style | kenBurns | color |
|---|---|---|---|---|---|
| `travel-cinematic` | 2.8 / 1.6 | fade, zoom | title-serif-white | slow, alternating pan | +sat, warm |
| `birthday-fun` | 1.6 / 0.9 | cut, slideleft | pop-bold-yellow | quick zoom-in | +bright |
| `product-promo` | 2.2 / 1.4 | cut, fade | clean-sans-brand | minimal | neutral |

### 6.4 Auto-edit (`autoedit_generate`) — deterministic given (inputs, seed)
1. **Candidates**: ready assets; drop `qualityScore < 0.35`; near-dupes = phash Hamming ≤ 8 → keep best-scored per cluster, cap 3 per burst cluster.
2. **Music**: user-picked `MusicTrack` else vibe-tagged seed track; `beatTimes` from analysis (librosa `beat_track`; if sparse, synthesize grid from tempo). Energy curve = RMS per beat, normalized.
3. **Slot plan**: walk beats from 0 to `targetSec`; slot duration = vibe pace interpolated by local energy, snapped to nearest beat multiple (min 0.7 s); last slot ends exactly at `targetSec` (trim/extend ±15%).
4. **Selection score** per candidate: `0.35*quality + 0.20*aesthetic(CLIP-tag prior) + 0.20*faceScore + 0.25*salience(highlight strength for video / tag-vibe affinity for image)` × steering multipliers (`peopleBias` ±0.15 on faceScore weight, etc.).
5. **Assignment**: chronological order (unless steering `bestMomentsFirst`); greedy fill with constraints — no two assets from same phash cluster adjacent; video:image ratio ≥ 40% video when available; each video clip uses its top unused highlight window, `srcIn/srcOut` = window fitted to slot duration (speed 1.0; allow 0.85–1.15 speed fit before re-trim).
6. **Decoration**: transitions from vibe (place `zoom/slide` only on downbeat slots, else cut/fade); kenBurns per vibe with direction alternating via seeded RNG; opening title card from event title if present.
7. Emit edit-spec (§5.1) → save to project → enqueue `render_preview`.
8. **Shuffle** = same call, new seed + exclusion set (≥40% of prior asset picks must differ — enforce by penalizing reused assets by −0.2).
*Unit-test this module hard: same seed ⇒ identical spec; shuffle-difference property; duration exactness; dedupe adjacency property.*

### 6.5 Beat-sync check (definition of "synced" for tests)
Every video-track cut time must lie within ±80 ms of a beat time (except first/last). Property-tested in pytest on all three vibes.

### 6.6 Renderer (`render_preview` / `render_final`) — edit-spec → FFmpeg
1. Build per-clip inputs: videos use proxy (preview) or original (final); trim `-ss/-to`, `setpts` for speed; scale-crop cover-fit to canvas; images → `zoompan` over `duration*fps` frames implementing kenBurns; label `[v0][v1]…`.
2. Transitions: chain `xfade` (`fade`, `slideleft`, `zoompan`-style via `xfade=zoomin`) at computed offsets; `cut` = plain concat boundary. (Build offsets carefully: xfade consumes overlap — recompute cumulative offsets; cover with golden tests.)
3. Text/captions: generate one `.ass` file — text clips as positioned dialogue events with fade/pop via `\t` tags; captions as karaoke `\k` word timings; styles from `styleId` map (Noto fonts); burn with `subtitles=` filter.
4. Color: `eq=brightness:contrast:saturation` from spec; optional LUT hook (none in v1).
5. Watermark: if `watermark.enabled` overlay `assets/watermark.png` bottom-right 6% width + 1.5 s outro card (drawtext) appended.
6. Audio: music trimmed/looped to duration; if any clip has speech (transcript exists) apply ducking = `volume` automation between word start/end windows (`duckUnderSpeechDb`), else music straight; master `loudnorm=I=-14:TP=-1.5`.
7. Encode: preview 540p ×fps30 CRF28 veryfast + AAC128; final 1080p (or 720p) CRF20 medium + AAC192, `+faststart`; write to `renders/`, then `ffprobe` verify (duration ±0.25 s of spec, correct WxH, streams=v+a) → store snapshot in `Export.ffprobe`; mismatch ⇒ job failed (auto-retry once).
8. Progress: parse ffmpeg `-progress pipe:` → update `job.result.progress` (0–100) every 2 s.

### 6.7 Image ops (`image_op`)
`enhance` = OpenCV CLAHE (LAB L-channel) + mild saturation + auto white-balance (gray-world), params exposed; `bg_remove` = rembg (isnet-general session) → PNG w/ alpha as new derived asset; `erase` = client sends mask PNG (canvas-drawn) → IOPaint/LaMa CPU; `upscale` = Real-ESRGAN ×2 CPU (cap input 2048px, warn slow). Each op ⇒ **new** derived `MediaAsset` (never overwrite originals), `synthetic` stays false for cleanup ops.

## 7. Editor UI (apps/web — the hardest frontend piece; build after pipeline works)

- **Layout**: preview canvas (aspect-correct, letterboxed) · timeline (video track, text track, audio track, caption row) · right properties panel · top bar (title, aspect, vibe re-apply, Export).
- **Preview strategy (v1, documented limitation)**: absolutely-positioned layers (`<video>` seeked to `srcIn + (t−timelineStart)`, `<img>` with CSS transform animating kenBurns) driven by a rAF clock; text clips as styled DOM; captions as DOM karaoke. **Transitions preview as hard cuts with a badge "transition: fade (final render only)"** — do NOT attempt WebCodecs/frame-accurate compositing in v1. Server `render_preview` (540p) available via "Preview render" button for truth.
- **Interactions**: select/trim (drag handles, snap to beats — show beat ticks), split at playhead, delete, reorder (drag), text add/edit with style presets, music replace (library/upload), caption editor = transcript list with inline word edit + per-word timing nudge, undo/redo (Zustand temporal, 50 steps), autosave PATCH debounced 800 ms.
- Keyboard: space play/pause, ←/→ frame-ish step (1/30 s), S split, Del delete.
- Mobile-web: view + basic trim/text; full editing desktop-first (this is the PWA compromise; note in UI).

## 8. AI Studio — fal.ai integration (nothing self-hosted)

### 8.1 Provider abstraction (`worker/lib/fal.py` + TS types in shared)
```
GenProvider.submit(kind, modelSlug, params) → {vendorJobId}
GenProvider.poll(vendorJobId) → {status: queued|running|done|failed, resultUrls?, costUsd?, error?}
Providers: FalProvider (httpx, fal queue API, poll every 3 s, timeout 10 min),
           StubProvider (returns fixture assets after 2 s — DEFAULT when FAL_KEY unset; CI always stub)
```

### 8.2 Model routing — seed `gen_models` (slugs are **placeholders — verify against fal.ai catalog at build time**, they churn; admin can edit)
| kind | tier | seed slug (verify!) | credits | unit |
|---|---|---|---|---|
| t2i | standard | `fal-ai/flux/schnell` | 2 | image |
| t2i | premium | `fal-ai/z-image` or current best Apache-licensed | 3 | image |
| i2v | draft | `fal-ai/wan/v2.2-5b/image-to-video` | 4 | second |
| i2v | standard | `fal-ai/kling-video/v3/standard/image-to-video` | 12 | second |
| t2v | draft | `fal-ai/wan/v2.2-a14b/text-to-video` | 4 | second |
| t2v | standard | `fal-ai/kling-video/v3/standard/text-to-video` | 12 | second |
| t2v | cinematic | `fal-ai/veo3` (if listed) | 45 | second |
| tts | standard | `fal-ai/kokoro` (en) / current multilingual | 1 | 100 chars |
| music | standard | current ACE-Step/stable-audio slug | 5 | track ≤60 s |

### 8.3 UX flows (studio pages)
- **Text→Image**: prompt + aspect + tier → grid of results → "Save to library".
- **Image→Video**: pick library image → motion prompt + duration (3–8 s) → result to library.
- **Text→Video**: prompt + tier + duration (3–8 s); show credit estimate before submit; optional **Best-of-2** toggle (2× credits, both takes shown, user keeps one — this is the v1 stand-in for the QC gate; leave `// QC-HOOK` where a scoring call would slot in).
- **TTS**: text + voice picker → audio asset (usable as project voiceover). **Music**: mood/genre + duration → `MusicTrack`.
- Every generated asset: `synthetic=true`, "AI" badge in library, and export flow shows a disclosure reminder line when a project contains synthetic assets (text only, no C2PA in v1).

### 8.4 Credits (atomic — get this right)
Single DB transaction on submit: `SELECT balance FOR UPDATE` → insufficient ⇒ 402-style error → else insert `CreditLedger(delta=−cost)` + update balance + create `Generation` + `Job`. On terminal failure: compensating ledger entry `refund` in the job's transaction. Ledger is append-only; `balanceAfter` must always reconcile (pytest property: replay ledger = balance).

### 8.5 Safety minimum (v1)
Prompt pre-filter: fal's own safety + a local blocklist (worker/lib/safety.py: CSAM-adjacent, real-person-nude patterns) → block with clear error; log to `generations.params.safety`. Full moderation stack is out of scope; leave `// MODERATION-HOOK`.

## 9. Plans, Watermark, Export presets

- Plans are **flags only**: `free` (watermark on, 720p max, 30 AI credits/mo top-up via admin, 5 auto-edits/mo soft limit) · `creator` (no watermark, 1080p, 300 credits/mo) · `business` (reserved, same as creator in v1). Admin page toggles plan per user. `PaymentsProvider` interface + `/api/webhooks/razorpay` stub route exist with TODO.
- Monthly credit grant job: on first request of a calendar month, top up to plan allowance if below (simple lazy grant; no cron needed).
- Export presets seed (from FRD): `reel {9:16, max 90, rec 30}`, `story {9:16, max 60}`, `short {9:16, max 180, rec 60}`, `square {1:1, max 120}`, `youtube {16:9, max 900}`. Export screen: preset → resolution (plan-gated) → render_final → download button + `navigator.share({files})` when supported + copy-caption box (template-based caption: title + 5 hashtag suggestions from tags; `// LLM-HOOK` for AI captions).

## 10. Build Phases — execute in order; each phase ends with its tests green in CI

| Phase | Deliverable | Exit tests (write them in the same phase) |
|---|---|---|
| **P0 Scaffold** | Monorepo, docker-compose (pg+minio), Prisma schema+migrate, better-auth (OTP console flow + session), app shell + nav, healthz on worker, CI pipeline | e2e: signup→OTP→land in Library; unit: editspec zod round-trip |
| **P1 Media library** | Presigned upload (multipart), analyze pipeline (§6.1), grid + asset drawer (tags, quality), events (§6.2), search by tag/date, `scripts/make_fixtures.sh` | e2e: upload 6 synthetic fixtures → all `ready`, thumbs render, event appears; pytest: quality scoring monotonicity, phash dedupe |
| **P2 Auto-edit + render** | Vibes seed, wizard (media/event → vibe → preset → target length), autoedit (§6.4), preview render (§6.6), project player page, Shuffle + steering chips, download | pytest: determinism/shuffle/beat-sync/duration properties; e2e: event → 20 s reel → player plays; ffprobe: duration/WxH/streams; shuffle ⇒ ≥40% different assets |
| **P3 Editor** | Timeline UI (§7), all interactions, autosave, preview-render button, re-export | e2e: trim clip → duration change persisted; add text → appears in re-rendered ffprobe'd output (probe: subtitle burned = frame diff at t vs baseline OR just assert render success + spec applied); unit: undo/redo state machine |
| **P4 Captions + audio** | transcribe job + caption editor, caption styles burn-in, music upload + beats, ducking, seed CC0 tracks script | pytest: .ass generation snapshot tests (en+hi); e2e: speech fixture → words editable → burned render completes |
| **P5 AI Studio** | Provider layer + StubProvider + FalProvider, gen_models seed + admin CRUD, credits (§8.4), all 5 studio flows, synthetic badges + disclosure line | pytest: ledger atomicity + refund property; e2e (stub): t2i → library; t2v best-of-2 → pick → credits correct; one live fal smoke test behind `RUN_LIVE_AI=1` (never in CI) |
| **P6 Image studio** | enhance / bg-remove / erase (mask canvas) / upscale flows on library images | e2e: bg-remove fixture → alpha PNG derived asset; pytest: mask plumbing |
| **P7 Plans + export + PWA** | Plan flags + gates (watermark, 1080p, credit grants), export presets screen, share/caption box, PWA manifest+SW, admin dashboard (jobs, flags, models, credits) | e2e: free export has watermark (sample corner pixels differ from content baseline), creator doesn't; preset caps enforced; admin credit adjust reflects in ledger |
| **P8 Hardening** | Full-suite pass, empty/error states for every async flow, loading skeletons, a11y pass (labels, focus, contrast), README + .env.example + Railway deploy doc, seed demo script | Entire e2e suite green 3× consecutively; then **ultra-review** (see CLAUDE.md) and fix everything it finds before reporting done |

## 11. Configuration & Deployment

### 11.1 `.env` schema (validate at boot with zod / pydantic; fail fast)
```
DATABASE_URL=            # postgres
S3_ENDPOINT= S3_ACCESS_KEY= S3_SECRET_KEY= S3_REGION=us-east-1
S3_BUCKET_ORIGINALS=originals S3_BUCKET_DERIVED=derived S3_BUCKET_RENDERS=renders S3_BUCKET_GENERATED=generated
AUTH_SECRET=             # better-auth
GOOGLE_CLIENT_ID= GOOGLE_CLIENT_SECRET=        # optional
RESEND_API_KEY=          # optional; absent ⇒ OTP logged to console
FAL_KEY=                 # absent ⇒ StubProvider
WORKER_CONCURRENCY=2
APP_URL=http://localhost:3000
```

### 11.2 Local dev
`docker compose -f infra/docker-compose.dev.yml up` (postgres, minio+bucket-init, worker with live-reload mount) + `pnpm dev` for web. `pnpm db:migrate`, `pnpm seed` (vibes, presets, gen_models, demo user), `bash scripts/make_fixtures.sh` before e2e.

### 11.3 Railway (document in README; no IaC needed v1)
Services: **web** (Dockerfile, Next standalone), **worker** (Dockerfile), **Postgres** (Railway plugin; enable pgvector if offered, else JSON fallback path is automatic), **MinIO** (Railway template + volume; or swap S3-compatible endpoint envs later — code must not assume MinIO specifically). Set env per §11.1; worker scales vertically first (CPU-bound ffmpeg); note: renders are CPU-real — set worker to Railway's higher-CPU plan and document expected times (§13).

## 12. OSS Dependency & License Register (allowlist — extend only with same license classes)
FFmpeg with libx264 (LGPL core + GPL encoder — **acceptable because rendering is server-side only; GPL obligations trigger on distribution, and we never ship this binary to users**; revisit if a desktop app ever embeds it) · sharp (Apache-2.0) · Pillow (HPND) · OpenCV (Apache-2.0) · PySceneDetect (BSD-3) · open_clip (MIT) · imagehash (BSD-2) · MediaPipe (Apache-2.0) · librosa (ISC) · faster-whisper (MIT) · rembg (MIT) · IOPaint/LaMa (Apache-2.0) · Real-ESRGAN (BSD-3) · better-auth (MIT) · Prisma (Apache-2.0) · SQLAlchemy (MIT) · Next.js/React (MIT) · Tailwind (MIT) · shadcn/ui (MIT) · Zustand (MIT) · zod (MIT) · Playwright (Apache-2.0) · vitest (MIT) · pytest (MIT) · MinIO client SDKs (Apache-2.0; MinIO server AGPL — **fine: we run it unmodified as infrastructure, we don't link to it**; note for legal) · Noto fonts (OFL).
**Banned**: anything CC-BY-NC-weighted, AGPL *libraries* linked into our code, CodeFormer, InsightFace models, A1111, Essentia.

## 13. NFR Targets for this build (CPU-only, honest numbers — assert the generous bounds in e2e)
Upload→analyzed: ≤ 90 s for 6 fixtures · Auto-edit plan: ≤ 10 s · Preview render 20 s @540p: ≤ 120 s · Final 30 s @1080p: ≤ 6 min on 4 vCPU · Editor interactions: ≤ 150 ms perceived; rAF preview ≥ 24 fps with proxies · API p95 ≤ 400 ms (non-job endpoints) · Zero unhandled promise rejections / worker tracebacks in e2e runs.

## 14. Definition of Done
All P0–P8 exit tests green in CI · `pnpm build` + worker image build clean · fresh-clone → README quickstart → working app in ≤ 15 min · seeded demo flow (fixtures → auto-edit → export with watermark) works on Railway · ultra-review findings fixed or explicitly waived in `REVIEW.md` · no TODOs outside the sanctioned hooks (`QC-HOOK`, `LLM-HOOK`, `MODERATION-HOOK`, `C2PA-HOOK`, Razorpay stub).
