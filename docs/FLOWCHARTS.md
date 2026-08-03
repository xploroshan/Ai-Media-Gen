# ReelForge v1 — Flow Charts

> Companion documents: [ARCHITECTURE.md](./ARCHITECTURE.md) · [DEPLOYMENT.md](./DEPLOYMENT.md)
>
> All diagrams are Mermaid (rendered natively by GitHub).

## 1. Job lifecycle state machine

Every asynchronous operation in the system is a row in the `jobs` table and
follows this one state machine (`worker/lib/db.py`):

```mermaid
stateDiagram-v2
    [*] --> queued : enqueue (web or worker)
    queued --> running : claim<br/>FOR UPDATE SKIP LOCKED<br/>attempts+1, locked_by set
    running --> done : complete_job<br/>(lease still held)
    running --> failed_retry : fail (attempts < 3)
    failed_retry --> queued : run_after backoff<br/>30 s → 2 min
    running --> failed : fail (attempts = 3)<br/>terminal
    running --> queued : sweeper reclaim<br/>(heartbeat stale > 5 min, attempts < 3)
    running --> failed : sweeper<br/>(stale + attempts = 3)
    running --> queued : graceful shutdown<br/>requeue_own_running (attempt refunded)
    done --> [*]
    failed --> [*]

    note right of running
        Every mutation is lease-guarded:
        WHERE status='running' AND locked_by=me.
        A worker that lost the lease gets
        rowcount 0 and discards its result.
    end note
```

## 2. Upload → analysis → event clustering

```mermaid
sequenceDiagram
    participant B as Browser
    participant W as Web API
    participant S3 as Object storage
    participant PG as Postgres (jobs)
    participant WK as Worker

    B->>W: POST /api/media/presign-upload {filename, bytes, kind}
    W->>S3: presign PUT (multipart if ≥64 MB)
    W->>PG: INSERT media_asset (status=uploading, final key)
    W-->>B: {assetId, uploadUrl | multipart{partUrls}}
    B->>S3: PUT bytes (direct, presigned)
    B->>W: POST /api/media/:id/complete
    W->>S3: HEAD object (exists?)
    W->>PG: uploading→analyzing (atomic claim, 409 on race)
    W->>PG: enqueue analyze_media (+beats if audio)
    Note over B: on failure: DELETE /api/media/:id<br/>aborts multipart + removes row

    WK->>PG: claim analyze_media
    WK->>S3: download original
    WK->>WK: probe/EXIF → thumbs → 540p proxy →<br/>quality → scene cuts → highlights →<br/>CLIP tags → faces → phash
    WK->>S3: upload thumbs + proxy (derived/)
    WK->>PG: upsert analysis, asset→ready
    Note over WK: any step fails → persist PARTIAL<br/>analysis, asset→failed (§6.1.8)
    WK->>PG: last analyzing asset for owner?<br/>advisory lock → enqueue detect_events
    WK->>PG: cluster by time gap over 4h / 25km,<br/>keep ≥6 → upsert events (detach dropped members)
```

## 3. Auto-edit: create wizard → plan → preview render

```mermaid
flowchart TD
    A[Create wizard<br/>media or event → vibe → preset → target length] --> B[POST /api/projects]
    B --> C{"free plan and<br/>over 5 auto-edits this month?"}
    C -- yes --> C1[soft-limit notice in response]
    C -- no --> D
    C1 --> D[Create project row<br/>seed = random, status=rendering]
    D --> E[enqueue autoedit_generate<br/>priority 3]

    E --> F[Worker: load ready+owned assets<br/>+ analysis, vibe config, music beats+energy]
    F --> G[plan_autoedit — PURE + seed-deterministic]
    G --> G1[filter: quality ≥ 0.35,<br/>phash dedupe, burst cap 3/12s]
    G1 --> G2[beat-snapped slots<br/>cuts within ±80 ms of a beat,<br/>pace from vibe × energy curve]
    G2 --> G3["score and pick: quality + aesthetics<br/>+ faces + salience, ≥40% video"]
    G3 --> G4[decorate: highlight windows,<br/>seeded kenBurns, downbeat transitions,<br/>title card, music bed]
    G4 --> H{projects.seed still = payload.seed?}
    H -- no --> H1[superseded by newer shuffle<br/>abort, no render]
    H -- yes --> I[save edit_spec, status=rendering<br/>enqueue render_preview]

    I --> J[Worker render slot:<br/>build_plan → ffmpeg xfade graph<br/>540p proxies, watermark]
    J --> K[ffprobe verify ±0.25 s<br/>upload renders/…/preview-jobId.mp4]
    K --> L[project status=ready]
    L --> M[Player polls GET /api/projects/:id<br/>→ presigned previewUrl]
    M --> N{Shuffle?}
    N -- yes --> O[409 if autoedit already running,<br/>else new seed + exclusion set<br/>≥40% different result] --> E
```

## 4. Editor: autosave and re-render

```mermaid
flowchart TD
    A[User edit<br/>trim / split / reorder / text / music / captions] --> B[zustand store<br/>pure ops keep §5.1 invariants<br/>undo/redo 50 steps]
    B --> C[debounce 800 ms]
    C --> D[PATCH /api/projects/:id editSpec]
    D --> E{autoedit job<br/>queued/running?}
    E -- yes --> E1[409 autoedit_in_progress<br/>client keeps dirty state]
    E -- no --> F[zod-validate spec<br/>+ ownership check on every referenced asset]
    F -- invalid --> F1[400 invalid_edit_spec]
    F -- foreign asset --> F2[403 forbidden_asset]
    F -- ok --> G[save spec]
    G --> H{render flag?}
    H -- "no (autosave)" --> I[200 — saved]
    H -- "yes (Preview render button)" --> J[status=rendering<br/>enqueue render_preview]
    J --> K[SWR polls project<br/>progress from job result]
    K --> L[new previewUrl key<br/>server render = truth]

    D -. network failure .-> M[saveState=error<br/>retry every 5 s while dirty<br/>beforeunload warning]
```

## 5. Export: plan gates → immutable final render

```mermaid
flowchart TD
    A[Export dialog<br/>preset + resolution] --> B[POST /api/projects/:id/export]
    B --> C{spec.durationSec<br/>≤ preset.maxSec?}
    C -- no --> C1[400 preset_cap]
    C -- yes --> D{1080p requested<br/>and plan = free?}
    D -- yes --> D1[403 plan_gate]
    D -- no --> E[create export row<br/>watermark = plan is free]
    E --> F[enqueue render_final with<br/>editSpecSnapshot — edits during the<br/>render cannot leak into this export]
    F --> G[Worker render slot:<br/>originals, full res,<br/>watermark + 1.5 s outro if free]
    G --> H{success?}
    H -- yes --> I[ffprobe verify → upload →<br/>export done + snapshot stored]
    H -- "fail (attempt < 3)" --> J[retry via backoff<br/>export stays queued]
    H -- "fail (terminal)" --> K[export → failed<br/>sweeper also reconciles strays]
    I --> L[client polls /api/exports/:id<br/>tolerates 5 transient misses]
    L --> M[presigned download<br/>navigator.share / LLM-HOOK caption]
```

## 6. AI generation with credit lifecycle (SPEC §8)

```mermaid
flowchart TD
    A[POST /api/generate<br/>kind, tier, prompt, params] --> B{prompt blocked?}
    B -- yes --> B1[422 — no spend]
    B -- no --> C[look up gen_models row<br/>slug + credit cost live in DB]
    C --> D["ONE transaction:<br/>SELECT profile FOR UPDATE →<br/>ledger row (negative delta), balanceAfter →<br/>balance update → generation + job rows"]
    D -- insufficient --> D1[402 insufficient_credits<br/>nothing written]
    D -- ok --> E[worker claims generate_ai]

    E --> F{status guard:<br/>queued/running → running}
    F -- rowcount 0 --> F1[superseded by reconciler<br/>skip, no delivery]
    F -- ok --> G[GenProvider.generate<br/>Stub without FAL_KEY / fal queue API]
    G --> H{take delivered?}
    H -- yes --> I[create asset rows + upload<br/>checkpoint results/takesDone<br/>same tx, guarded status=running]
    I --> J{more takes?<br/>best-of-2 = 2}
    J -- yes --> G
    H -- no --> K{any results?}
    J -- no --> L{all takes delivered?}
    L -- yes --> M[done tx guarded:<br/>status→done, vendor cost]
    L -- "partial (terminal)" --> N[done tx + partial refund:<br/>ledger partial_refund,<br/>credit_cost reduced]
    K -- "no (attempts left)" --> O[raise → retry with backoff<br/>checkpoint resumes missing takes]
    K -- "no (terminal)" --> P[record error →<br/>refund_generation]
    M --> Q[enqueue analyze_media / beats<br/>assets get synthetic=true + AI badge]
    N --> Q
    P --> R[refund: idempotent across reasons,<br/>refuses done rows, status→refunded<br/>same tx as ledger row]

    S[Sweeper each 60 s] -.-> T[generations with failed job,<br/>no positive ledger row] -.-> R
    Q --> U{best-of-2?}
    U -- yes --> V[resultAssetId stays NULL<br/>user picks — atomic updateMany,<br/>second pick gets 409]
```

## 7. Image studio operation

```mermaid
flowchart LR
    A[Pick image] --> B{op}
    B -- enhance --> C[CLAHE + white balance<br/>+ mild saturation]
    B -- bg_remove --> D[rembg isnet<br/>→ RGBA PNG]
    B -- erase --> E[canvas mask upload<br/>→ LaMa inpaint]
    B -- upscale --> F[Real-ESRGAN ×2<br/>input capped 2048 px]
    C & D & E & F --> G[upload to deterministic<br/>derived/ key FIRST]
    G --> H[INSERT new derived asset<br/>original stays immutable]
    H --> I[enqueue analyze_media<br/>→ thumbs, quality, tags]
    I --> J[appears in library<br/>as a new asset]
```

## 8. Worker process anatomy

```mermaid
flowchart TD
    subgraph proc [worker container - one process]
        MAIN[__main__: validate env,<br/>load handlers, spawn threads]
        MAIN --> U[uvicorn :8001/healthz<br/>signals owned by us, not uvicorn]
        MAIN --> S0["poller slot 0<br/>RENDER JOBS ONLY when concurrency above 1"]
        MAIN --> SN[poller slots 1..N-1<br/>all non-render types]
        MAIN --> SW[sweeper every 60 s]
    end

    S0 & SN --> CLAIM[claim → validate payload →<br/>heartbeat thread 30 s → handler →<br/>complete/fail lease-guarded]
    SW --> SW1["requeue stale running<br/>fail exhausted"]
    SW --> SW2[refund orphaned generations]
    SW --> SW3[reconcile stuck projects /<br/>exports / assets 10 min grace]

    SIG[SIGTERM / SIGINT] --> DRAIN[stop pollers → join 10 s →<br/>requeue own running jobs<br/>without burning an attempt]
```
