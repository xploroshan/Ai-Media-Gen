/**
 * Seed: vibes (§6.3), platform presets (§9), gen_models (§8.2 — slugs are
 * placeholders held in DB, admin-editable; verified against fal catalog in P5),
 * and a demo admin user. Idempotent (upserts).
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const VIBES = [
  {
    id: "travel-cinematic",
    name: "Travel Cinematic",
    sortOrder: 1,
    config: {
      paceSec: { low: 2.8, high: 1.6 },
      transitions: ["fade", "zoom"],
      captionStyle: "title-serif-white",
      kenBurns: { style: "slow", alternatePan: true },
      color: { saturation: 0.15, temperature: "warm" },
    },
  },
  {
    id: "birthday-fun",
    name: "Birthday Fun",
    sortOrder: 2,
    config: {
      paceSec: { low: 1.6, high: 0.9 },
      transitions: ["cut", "slideleft"],
      captionStyle: "pop-bold-yellow",
      kenBurns: { style: "quick-zoom-in", alternatePan: false },
      color: { brightness: 0.1 },
    },
  },
  {
    id: "product-promo",
    name: "Product Promo",
    sortOrder: 3,
    config: {
      paceSec: { low: 2.2, high: 1.4 },
      transitions: ["cut", "fade"],
      captionStyle: "clean-sans-brand",
      kenBurns: { style: "minimal", alternatePan: false },
      color: {},
    },
  },
];

const PRESETS = [
  { id: "reel", name: "Instagram Reel", aspect: "9:16", maxSec: 90, recSec: 30 },
  { id: "story", name: "Story", aspect: "9:16", maxSec: 60, recSec: 15 },
  { id: "short", name: "YouTube Short", aspect: "9:16", maxSec: 180, recSec: 60 },
  { id: "square", name: "Square Post", aspect: "1:1", maxSec: 120, recSec: 30 },
  { id: "youtube", name: "YouTube 16:9", aspect: "16:9", maxSec: 900, recSec: 60 },
];

// SPEC §8.2 seed table. Slugs live ONLY here (DB), never hardcoded in app/worker code.
const GEN_MODELS = [
  {
    kind: "t2i",
    tier: "standard",
    modelSlug: "fal-ai/flux/schnell",
    creditPerUnit: 2,
    unit: "image",
  },
  { kind: "t2i", tier: "premium", modelSlug: "fal-ai/z-image", creditPerUnit: 3, unit: "image" },
  {
    kind: "i2v",
    tier: "draft",
    modelSlug: "fal-ai/wan/v2.2-5b/image-to-video",
    creditPerUnit: 4,
    unit: "second",
  },
  {
    kind: "i2v",
    tier: "standard",
    modelSlug: "fal-ai/kling-video/v3/standard/image-to-video",
    creditPerUnit: 12,
    unit: "second",
  },
  {
    kind: "t2v",
    tier: "draft",
    modelSlug: "fal-ai/wan/v2.2-a14b/text-to-video",
    creditPerUnit: 4,
    unit: "second",
  },
  {
    kind: "t2v",
    tier: "standard",
    modelSlug: "fal-ai/kling-video/v3/standard/text-to-video",
    creditPerUnit: 12,
    unit: "second",
  },
  { kind: "t2v", tier: "cinematic", modelSlug: "fal-ai/veo3", creditPerUnit: 45, unit: "second" },
  { kind: "tts", tier: "standard", modelSlug: "fal-ai/kokoro", creditPerUnit: 1, unit: "100chars" },
  {
    kind: "music",
    tier: "standard",
    modelSlug: "fal-ai/ace-step",
    creditPerUnit: 5,
    unit: "track60s",
  },
];

async function main() {
  for (const vibe of VIBES) {
    await prisma.vibe.upsert({
      where: { id: vibe.id },
      create: vibe,
      update: { name: vibe.name, config: vibe.config, sortOrder: vibe.sortOrder },
    });
  }

  for (const preset of PRESETS) {
    await prisma.platformPreset.upsert({
      where: { id: preset.id },
      create: preset,
      update: preset,
    });
  }

  for (const model of GEN_MODELS) {
    await prisma.genModel.upsert({
      where: { kind_tier: { kind: model.kind, tier: model.tier } },
      create: { ...model, providerId: "fal", active: true },
      update: { modelSlug: model.modelSlug, creditPerUnit: model.creditPerUnit, unit: model.unit },
    });
  }

  // Demo admin user (email OTP sign-in creates the auth rows on first login;
  // this pre-provisions the account so the profile is admin-flagged).
  const demoEmail = "demo@reelforge.local";
  const demo = await prisma.user.upsert({
    where: { email: demoEmail },
    create: {
      id: "demo-user-000000000000000",
      name: "Demo Admin",
      email: demoEmail,
      emailVerified: true,
    },
    update: {},
  });
  await prisma.profile.upsert({
    where: { id: demo.id },
    create: { id: demo.id, displayName: "Demo Admin", isAdmin: true, creditsBalance: 120 },
    update: { isAdmin: true },
  });
  const hasBonus = await prisma.creditLedger.findFirst({
    where: { ownerId: demo.id, reason: "signup_bonus" },
  });
  if (!hasBonus) {
    await prisma.creditLedger.create({
      data: { ownerId: demo.id, delta: 120, reason: "signup_bonus", balanceAfter: 120 },
    });
  }

  console.log("Seeded: vibes, platform presets, gen models, demo admin");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
