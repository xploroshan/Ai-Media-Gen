# Deploying ReelForge — a beginner's step-by-step walkthrough

This guide assumes **no prior deployment experience**. Follow it top to bottom
and you will end with a live, public ReelForge at your own URL. Budget about
**60–90 minutes** the first time.

> Already comfortable with Docker/Railway? Use the shorter
> [DEPLOYMENT.md](./DEPLOYMENT.md) instead.

## What you are going to set up

ReelForge is made of 4 pieces that must all run for the app to work:

| Piece        | What it is                            | Where it will live        |
| ------------ | ------------------------------------- | ------------------------- |
| **Postgres** | The database (users, projects, jobs)  | Railway (one click)       |
| **Storage**  | Where photo/video files live (S3 API) | Railway MinIO template    |
| **web**      | The website people visit              | Railway (from Dockerfile) |
| **worker**   | The machine that renders videos       | Railway (from Dockerfile) |

**Railway** (railway.com) is a hosting service that runs all four from one
dashboard, which is why this guide uses it. Expect roughly **$20–40/month**,
dominated by the worker (video rendering needs real CPU). You can pause or
delete the project at any time.

---

## Part 0 — Things to prepare first (15 min)

### 0.1 Accounts

Create (or have ready) these free accounts:

1. **GitHub** — you already have the code at `github.com/xploroshan/Ai-Media-Gen`.
2. **Railway** — sign up at <https://railway.com> **using your GitHub account**
   ("Login with GitHub"). This matters: it lets Railway see your repository.
   You will need the Hobby plan (paid, ~$5 base) to deploy — the free trial
   also works for a test run.
3. **Resend** (for login emails) — sign up at <https://resend.com>. Free tier
   is enough. You'll create an API key in Part 5.
4. _(Optional)_ **fal.ai** — only if you want real AI generation instead of the
   built-in stub. Sign up at <https://fal.ai> and note your API key.

### 0.2 Install tools on your computer

You need these once, to run the database setup command in Part 4.

- **Node.js 22**: download the LTS installer from <https://nodejs.org>.
  Verify in a terminal: `node --version` → should print `v22.x`.
- **pnpm**: in a terminal run `npm install -g pnpm@10` then check
  `pnpm --version`.
- **Git**: <https://git-scm.com/downloads> (macOS/Linux usually have it).
  Check with `git --version`.

> **What is "a terminal"?** On Windows use _PowerShell_ (search the Start
> menu). On macOS use _Terminal_ (Spotlight → "Terminal"). Every command in
> this guide is typed there and run by pressing Enter.

### 0.3 Get the code onto your computer

```bash
git clone https://github.com/xploroshan/Ai-Media-Gen.git
cd Ai-Media-Gen
pnpm install
```

`pnpm install` takes a few minutes the first time. If it ends without red
error text, you're good.

### 0.4 Generate a secret

The app needs one long random password (`AUTH_SECRET`) to sign login sessions.
Generate it now and paste it somewhere safe (a notes file is fine — you'll
paste it into Railway later):

- macOS/Linux: `openssl rand -base64 48`
- Windows PowerShell:
  `[Convert]::ToBase64String((1..48 | ForEach-Object { Get-Random -Maximum 256 }))`
- Or just mash ~60 random characters on your keyboard. Length matters
  (minimum 32 characters), memorability doesn't.

---

## Part 1 — Create the Railway project + database (5 min)

1. Go to <https://railway.com> and log in.
2. Click **New Project**.
3. Choose **Deploy PostgreSQL**. That's it — your project now exists and
   contains a Postgres database.
4. (Optional) Click the project name at the top and rename it to `reelforge`.
5. Click the **Postgres** card → **Variables** tab → find `DATABASE_URL` →
   click the copy icon. Paste it into your notes file. It looks like
   `postgresql://postgres:****@yamanote.proxy.rlwy.net:12345/railway`.

> Railway shows two URLs: `DATABASE_URL` (internal, only reachable from inside
> Railway) and `DATABASE_PUBLIC_URL` (reachable from your laptop). Copy
> **both** — you'll use the public one once in Part 4, and the internal one
> for the services.

---

## Part 2 — Add file storage (MinIO) (10 min)

ReelForge stores photos/videos in an "S3-compatible" object store. The easiest
on Railway is the **MinIO template**.

1. In your Railway project click **+ Create** (or **New**) → **Template** →
   search for **MinIO** → pick the official-looking MinIO template → **Deploy**.
2. When it finishes, click the MinIO service → **Variables** tab. Note down:
   - the **root user / access key** (often `MINIO_ROOT_USER`)
   - the **root password / secret key** (`MINIO_ROOT_PASSWORD`)
3. Click **Settings** tab → **Networking** → make sure the **API port (9000)**
   has a **public domain** (click _Generate Domain_ if there isn't one, and
   select port **9000**, not the 9001 console). Note the URL, e.g.
   `https://minio-production-abcd.up.railway.app`. This is your `S3_ENDPOINT`.

   > **Why public?** The browser uploads files _directly_ to storage using
   > presigned URLs. If the storage endpoint isn't publicly reachable, uploads
   > will hang at 0%.

4. If the template also exposes the **console (port 9001)**, generate a domain
   for it too and open it in your browser. Log in with the root user/password.
5. In the MinIO console, create **four buckets** (Buckets → Create Bucket),
   named exactly:
   - `originals`
   - `derived`
   - `renders`
   - `generated`

> **Alternative:** any S3-compatible store works (Cloudflare R2, AWS S3,
> Backblaze B2). If you use one of those, create the same four buckets and use
> its endpoint/keys in the variables below.

---

## Part 3 — Deploy the web and worker services (20 min)

Both are deployed **from your GitHub repository**, each using its own
Dockerfile.

### 3.1 The web service

1. In the Railway project: **+ Create** → **GitHub Repo** →
   pick `xploroshan/Ai-Media-Gen`. (First time, Railway will ask to install its
   GitHub app — allow it access to this repository.)
2. Railway creates a service and immediately tries to build. It may fail —
   that's fine, we haven't configured it yet.
3. Click the new service → **Settings**:
   - Rename it to `web`.
   - Under **Build**, set **Dockerfile Path** to `apps/web/Dockerfile`.
     (If you don't see the field, add a service variable
     `RAILWAY_DOCKERFILE_PATH` = `apps/web/Dockerfile` instead — same effect.)
   - Under **Networking**, click **Generate Domain** (port **3000**). This is
     your public website URL, e.g. `https://web-production-1234.up.railway.app`.
     Note it down.
4. Go to the **Variables** tab and add these (**New Variable** for each).
   Watch spelling exactly:

   | Name                  | Value                                                                                                        |
   | --------------------- | ------------------------------------------------------------------------------------------------------------ |
   | `DATABASE_URL`        | the **internal** Postgres URL from Part 1 (or use Railway's _Reference_ feature → Postgres → `DATABASE_URL`) |
   | `S3_ENDPOINT`         | your MinIO public URL from Part 2.3 (starts with `https://`)                                                 |
   | `S3_ACCESS_KEY`       | MinIO root user from Part 2.2                                                                                |
   | `S3_SECRET_KEY`       | MinIO root password from Part 2.2                                                                            |
   | `S3_REGION`           | `us-east-1`                                                                                                  |
   | `S3_BUCKET_ORIGINALS` | `originals`                                                                                                  |
   | `S3_BUCKET_DERIVED`   | `derived`                                                                                                    |
   | `S3_BUCKET_RENDERS`   | `renders`                                                                                                    |
   | `S3_BUCKET_GENERATED` | `generated`                                                                                                  |
   | `AUTH_SECRET`         | the long random string from Part 0.4                                                                         |
   | `APP_URL`             | the web service's public URL from step 3.3 (e.g. `https://web-production-1234.up.railway.app`)               |

   Leave `RESEND_API_KEY`, `FAL_KEY`, `GOOGLE_CLIENT_ID/SECRET` out for now —
   we add email in Part 5.

5. Click **Deploy** (Railway usually redeploys automatically when variables
   change). Wait for the build — the first one takes ~5 minutes. Success looks
   like a green "Active" deployment.

### 3.2 The worker service

1. **+ Create** → **GitHub Repo** → the same `Ai-Media-Gen` repo again.
2. Service **Settings**:
   - Rename to `worker`.
   - **Dockerfile Path**: `services/worker/Dockerfile` (or variable
     `RAILWAY_DOCKERFILE_PATH` = `services/worker/Dockerfile`).
   - **No public domain needed** — the worker doesn't serve users.
3. **Variables** — add:

   | Name                  | Value                                 |
   | --------------------- | ------------------------------------- |
   | `DATABASE_URL`        | same internal Postgres URL as the web |
   | `S3_ENDPOINT`         | same as web                           |
   | `S3_ACCESS_KEY`       | same as web                           |
   | `S3_SECRET_KEY`       | same as web                           |
   | `S3_REGION`           | `us-east-1`                           |
   | `S3_BUCKET_ORIGINALS` | `originals`                           |
   | `S3_BUCKET_DERIVED`   | `derived`                             |
   | `S3_BUCKET_RENDERS`   | `renders`                             |
   | `S3_BUCKET_GENERATED` | `generated`                           |
   | `WORKER_CONCURRENCY`  | `2`                                   |

4. **Important — give it muscle**: Settings → scroll to the resource limits
   and allow at least **4 vCPU / 4–8 GB RAM** if your plan lets you. Video
   rendering and AI analysis are CPU-heavy; on a tiny instance renders will be
   painfully slow.
5. Deploy. **The first worker build takes a while (15–30 min)** — it installs
   PyTorch and downloads all AI model files into the image. This only happens
   on the first build and after dependency changes. Later deploys reuse the
   cached layers.
6. When it's running, open the worker's **Logs** tab. Healthy looks like:

   ```
   worker <name> starting, concurrency=2, handlers=['analyze_media', ...]
   ```

   If instead you see `validation error` lines, a variable is misspelled or
   missing — fix it and redeploy.

---

## Part 4 — Set up the database tables + starter data (5 min)

The database exists but is empty. Run the migration + seed **once from your
laptop**, pointed at the Railway database.

1. In Railway → Postgres → Variables, copy **`DATABASE_PUBLIC_URL`** (the one
   your laptop can reach).
2. In your terminal, inside the `Ai-Media-Gen` folder:

   macOS/Linux:

   ```bash
   export DATABASE_URL="postgresql://postgres:PASTE-THE-PUBLIC-URL-HERE"
   pnpm db:migrate
   pnpm seed
   ```

   Windows PowerShell:

   ```powershell
   $env:DATABASE_URL = "postgresql://postgres:PASTE-THE-PUBLIC-URL-HERE"
   pnpm db:migrate
   pnpm seed
   ```

3. Expected output: `All migrations have been successfully applied.` and then
   seed lines creating vibes, presets, models, and a demo user.

This creates all tables plus the starter content: 3 vibes, platform presets,
AI model entries, seed music, and an **admin account `demo@reelforge.local`**.

---

## Part 5 — Turn on real login emails (10 min)

Right now the app has no way to email login codes (OTPs). Without this, nobody
can sign in on the public site.

1. In **Resend** (<https://resend.com>): **API Keys** → **Create API Key** →
   copy the `re_...` value.
2. To send from your own address, add and verify your domain under
   **Domains** (follow their DNS instructions). Skipping this limits you to
   Resend's test sender — fine for trying things out.
3. In Railway → **web** service → Variables → add:

   | Name             | Value    |
   | ---------------- | -------- |
   | `RESEND_API_KEY` | `re_...` |

4. Redeploy the web service.

_(Optional now or later)_:

- **Google login**: create OAuth credentials at
  <https://console.cloud.google.com> → APIs & Services → Credentials →
  OAuth client ID (Web). Authorized redirect URI:
  `https://YOUR-WEB-URL/api/auth/callback/google`. Then set
  `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` on the web service.
- **Real AI generation**: set `FAL_KEY` (from fal.ai) on **both** web and
  worker services. Without it, the "AI Studio" produces placeholder stub
  images/videos — everything else works normally.

---

## Part 6 — First login and smoke test (10 min)

1. Open your web URL (from Part 3.1, step 3.3).
2. Click through to login and enter **your email** → you'll receive a 6-digit
   code from Resend → enter it. You're in.
3. **Upload test**: Library → upload 2–3 phone photos. Within ~a minute they
   should get thumbnails and show quality/tags in the side drawer. If they
   stay "analyzing" forever, check the worker logs (see troubleshooting).
4. **The real test**: upload ~6 photos/videos → **Create** → pick them → pick
   a vibe → Reel → 20 s → Create. Watch the progress; in a few minutes you
   get a playable beat-synced preview. Try **Shuffle**, open the **Editor**,
   then **Export** (free plan = 720p with watermark).
5. **Make yourself admin**: sign in as `demo@reelforge.local` (it receives a
   real OTP email only if your Resend domain can send to it — if not, use the
   admin SQL below), go to **Admin → Users**, find your own account, set plan
   / grant credits, and optionally make yourself admin. Direct SQL
   alternative (Railway → Postgres → **Data**/Query tab):

   ```sql
   UPDATE profiles SET is_admin = true
   WHERE id = (SELECT id FROM "user" WHERE email = 'you@example.com');
   ```

6. **If you set `FAL_KEY`**: go to **Admin → Models** and verify each model's
   slug against fal.ai's current catalog, then run one small t2i generation.
   The seeded slugs are placeholders and may need updating (this is expected —
   see DECISIONS.md #8).

---

## Part 7 — Ongoing basics

- **Deploy updates**: push to the GitHub branch Railway watches — it rebuilds
  automatically. If a database migration was added, re-run Part 4 step 2
  (`pnpm db:migrate` only; never re-run `pnpm seed` on a live database unless
  you want the seed rows re-checked).
- **Costs**: the worker is the expensive part. You can scale it down (or set
  Railway's "serverless"/sleep option) when unused — queued jobs simply wait
  and run when it wakes.
- **Backups**: Railway Postgres supports backups in the dashboard — enable
  them. Media files live in MinIO's volume; consider a periodic bucket sync if
  the content matters.

## Troubleshooting

| Symptom                                                       | Likely cause → fix                                                                                                                              |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Web build fails immediately                                   | Dockerfile path not set — Settings → Build → `apps/web/Dockerfile`.                                                                             |
| Web crashes on boot, logs mention env / "Invalid environment" | A required variable is missing or misspelled. Compare against the table in Part 3.1 — the log names the exact variable.                         |
| Login code never arrives                                      | `RESEND_API_KEY` not set on web, or Resend domain not verified (check Resend dashboard → Logs).                                                 |
| Upload stuck at 0%                                            | `S3_ENDPOINT` is not publicly reachable, or is the console URL (port 9001) instead of the API (9000). The browser must be able to reach it.     |
| Upload finishes but asset stuck "analyzing"                   | Worker is down or can't reach DB/storage — read the worker Logs tab; the stuck asset auto-fails after ~10 min (sweeper) and can be re-uploaded. |
| "Insufficient credits"                                        | Grant credits: Admin → Users → credit adjust (new signups start with 120).                                                                      |
| Renders extremely slow                                        | Worker instance too small — give it more vCPU (Part 3.2 step 4).                                                                                |
| AI Studio returns obviously fake test images                  | That's the stub provider — set `FAL_KEY` on web + worker and verify slugs in Admin → Models.                                                    |
| `pnpm db:migrate` from laptop can't connect                   | You used the internal URL — use `DATABASE_PUBLIC_URL` from the Postgres service.                                                                |

## Deployment map

```mermaid
flowchart LR
    subgraph railway [Railway project]
        WEB[web service<br/>apps/web/Dockerfile<br/>public domain :3000]
        WK[worker service<br/>services/worker/Dockerfile<br/>no public domain]
        PG[(PostgreSQL<br/>plugin)]
        MINIO[(MinIO template<br/>public API domain :9000<br/>4 buckets)]
    end
    USER((Your users)) -->|APP_URL| WEB
    USER -->|presigned upload/download| MINIO
    WEB --> PG
    WEB --> MINIO
    WK --> PG
    WK --> MINIO
    WK -.->|only if FAL_KEY| FAL[fal.ai]
    RESEND[Resend<br/>login emails] --- WEB
```
