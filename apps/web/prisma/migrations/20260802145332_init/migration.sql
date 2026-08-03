-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "email_verified" BOOLEAN NOT NULL DEFAULT false,
    "image" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "token" TEXT NOT NULL,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounts" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "access_token" TEXT,
    "refresh_token" TEXT,
    "id_token" TEXT,
    "access_token_expires_at" TIMESTAMP(3),
    "refresh_token_expires_at" TIMESTAMP(3),
    "scope" TEXT,
    "password" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verifications" (
    "id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "verifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "profiles" (
    "id" TEXT NOT NULL,
    "display_name" TEXT,
    "locale" TEXT NOT NULL DEFAULT 'en',
    "persona_hint" TEXT,
    "plan" TEXT NOT NULL DEFAULT 'free',
    "credits_balance" INTEGER NOT NULL DEFAULT 120,
    "is_admin" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_assets" (
    "id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "thumb_key" TEXT,
    "proxy_key" TEXT,
    "filename" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "duration_sec" DOUBLE PRECISION,
    "fps" DOUBLE PRECISION,
    "taken_at" TIMESTAMP(3),
    "gps_lat" DOUBLE PRECISION,
    "gps_lng" DOUBLE PRECISION,
    "phash" TEXT,
    "synthetic" BOOLEAN NOT NULL DEFAULT false,
    "event_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "media_assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_analysis" (
    "asset_id" TEXT NOT NULL,
    "quality_score" DOUBLE PRECISION,
    "blur_var" DOUBLE PRECISION,
    "exposure_score" DOUBLE PRECISION,
    "tags" JSONB,
    "clip_embedding" JSONB,
    "faces_count" INTEGER,
    "face_area_ratio" DOUBLE PRECISION,
    "scene_cuts" JSONB,
    "highlights" JSONB,
    "beat_times" JSONB,
    "transcript" JSONB,

    CONSTRAINT "media_analysis_pkey" PRIMARY KEY ("asset_id")
);

-- CreateTable
CREATE TABLE "events" (
    "id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "start_at" TIMESTAMP(3) NOT NULL,
    "end_at" TIMESTAMP(3) NOT NULL,
    "asset_ids" JSONB NOT NULL,

    CONSTRAINT "events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects" (
    "id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT 'Untitled',
    "aspect" TEXT NOT NULL DEFAULT '9:16',
    "vibe_id" TEXT,
    "preset_id" TEXT,
    "edit_spec" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "seed" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jobs" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "priority" INTEGER NOT NULL DEFAULT 5,
    "payload" JSONB NOT NULL,
    "result" JSONB,
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "locked_by" TEXT,
    "locked_at" TIMESTAMP(3),
    "run_after" TIMESTAMP(3),
    "owner_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "generations" (
    "id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "model_slug" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "params" JSONB NOT NULL,
    "credit_cost" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "result_asset_id" TEXT,
    "vendor_cost_usd" DOUBLE PRECISION,
    "job_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "generations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_ledger" (
    "id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "delta" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "ref_id" TEXT,
    "balance_after" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exports" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "preset_id" TEXT NOT NULL,
    "resolution" TEXT NOT NULL,
    "watermark" BOOLEAN NOT NULL,
    "storage_key" TEXT,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "ffprobe" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vibes" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "sort_order" INTEGER NOT NULL,

    CONSTRAINT "vibes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_presets" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "aspect" TEXT NOT NULL,
    "max_sec" INTEGER NOT NULL,
    "rec_sec" INTEGER NOT NULL,
    "notes" TEXT,

    CONSTRAINT "platform_presets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gen_models" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "model_slug" TEXT NOT NULL,
    "credit_per_unit" INTEGER NOT NULL,
    "unit" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "gen_models_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feature_flags" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,

    CONSTRAINT "feature_flags_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "music_tracks" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "duration_sec" DOUBLE PRECISION NOT NULL,
    "beat_times" JSONB,
    "license" TEXT NOT NULL,
    "attribution" TEXT,
    "owner_id" TEXT,
    "vibe_tags" JSONB,

    CONSTRAINT "music_tracks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_key" ON "sessions"("token");

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

-- CreateIndex
CREATE INDEX "accounts_user_id_idx" ON "accounts"("user_id");

-- CreateIndex
CREATE INDEX "verifications_identifier_idx" ON "verifications"("identifier");

-- CreateIndex
CREATE INDEX "media_assets_owner_id_status_idx" ON "media_assets"("owner_id", "status");

-- CreateIndex
CREATE INDEX "media_assets_owner_id_taken_at_idx" ON "media_assets"("owner_id", "taken_at");

-- CreateIndex
CREATE INDEX "events_owner_id_start_at_idx" ON "events"("owner_id", "start_at");

-- CreateIndex
CREATE INDEX "projects_owner_id_updated_at_idx" ON "projects"("owner_id", "updated_at");

-- CreateIndex
CREATE INDEX "jobs_status_priority_created_at_idx" ON "jobs"("status", "priority", "created_at");

-- CreateIndex
CREATE INDEX "generations_owner_id_created_at_idx" ON "generations"("owner_id", "created_at");

-- CreateIndex
CREATE INDEX "credit_ledger_owner_id_created_at_idx" ON "credit_ledger"("owner_id", "created_at");

-- CreateIndex
CREATE INDEX "exports_owner_id_created_at_idx" ON "exports"("owner_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "gen_models_kind_tier_key" ON "gen_models"("kind", "tier");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_analysis" ADD CONSTRAINT "media_analysis_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "media_assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
