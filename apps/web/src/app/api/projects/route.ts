import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiError, emptyEditSpec, type EditSpec } from "@reelforge/shared";
import { prisma } from "@/lib/db";
import { enqueueJob } from "@/lib/jobs";
import { apiSession } from "@/lib/session";
import { withApi } from "@/lib/with-api";

const BodySchema = z
  .object({
    assetIds: z.array(z.string().min(1)).optional(),
    eventId: z.string().optional(),
    vibeId: z.string().min(1),
    presetId: z.string().min(1),
    targetSec: z.number().positive().max(900),
    title: z.string().max(120).optional(),
  })
  .refine((b) => b.assetIds?.length || b.eventId, {
    message: "assetIds or eventId required",
  });

/** POST /api/projects — create project + autoedit job (SPEC §5.4). */
async function handlePOST(req: NextRequest) {
  const { session, response } = await apiSession();
  if (response) return response;

  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      apiError("bad_request", parsed.error.issues[0]?.message ?? "Invalid body"),
      { status: 400 },
    );
  }
  const body = parsed.data;

  const preset = await prisma.platformPreset.findUnique({ where: { id: body.presetId } });
  if (!preset) {
    return NextResponse.json(apiError("bad_request", "Unknown preset"), { status: 400 });
  }
  const vibe = await prisma.vibe.findUnique({ where: { id: body.vibeId } });
  if (!vibe) {
    return NextResponse.json(apiError("bad_request", "Unknown vibe"), { status: 400 });
  }
  const targetSec = Math.min(body.targetSec, preset.maxSec);

  let assetIds = body.assetIds ?? [];
  let title = body.title;
  if (body.eventId) {
    const event = await prisma.event.findUnique({ where: { id: body.eventId } });
    if (!event || event.ownerId !== session.user.id) {
      return NextResponse.json(apiError("not_found", "Event not found"), { status: 404 });
    }
    assetIds = event.assetIds as string[];
    title ??= event.title;
  }

  // only assets the caller owns AND that are ready may enter the job payload
  const ownedReady = await prisma.mediaAsset.findMany({
    where: { id: { in: assetIds }, ownerId: session.user.id, status: "ready" },
    select: { id: true },
  });
  const ownedIds = new Set(ownedReady.map((a) => a.id));
  if (!body.eventId && assetIds.some((assetId) => !ownedIds.has(assetId))) {
    return NextResponse.json(
      apiError("forbidden_asset", "Selection references media you don't own or that isn't ready"),
      { status: 403 },
    );
  }
  assetIds = assetIds.filter((assetId) => ownedIds.has(assetId));
  if (assetIds.length === 0) {
    return NextResponse.json(apiError("bad_request", "No ready assets selected"), { status: 400 });
  }

  // free plan: 5 auto-edits per month, soft limit (SPEC §9) — warn, don't block
  const profile = await prisma.profile.findUnique({ where: { id: session.user.id } });
  let softLimitReached = false;
  if ((profile?.plan ?? "free") === "free") {
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    const autoEditsThisMonth = await prisma.job.count({
      where: {
        type: "autoedit_generate",
        ownerId: session.user.id,
        createdAt: { gte: monthStart },
      },
    });
    softLimitReached = autoEditsThisMonth >= 5;
  }

  const seed = Math.floor(Math.random() * 2 ** 31);
  const project = await prisma.project.create({
    data: {
      ownerId: session.user.id,
      title: title ?? "Untitled",
      aspect: preset.aspect,
      vibeId: body.vibeId,
      presetId: body.presetId,
      editSpec: emptyEditSpec(preset.aspect as EditSpec["aspect"]) as object,
      seed,
      status: "draft",
    },
  });
  const jobId = await enqueueJob(
    "autoedit_generate",
    {
      projectId: project.id,
      assetIds,
      vibeId: body.vibeId,
      presetId: body.presetId,
      targetSec,
      seed,
    },
    { ownerId: session.user.id, priority: 3 },
  );
  return NextResponse.json({ projectId: project.id, jobId, softLimitReached });
}

/** GET /api/projects — list own projects. */
async function handleGET() {
  const { session, response } = await apiSession();
  if (response) return response;
  const projects = await prisma.project.findMany({
    where: { ownerId: session.user.id },
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      title: true,
      aspect: true,
      status: true,
      vibeId: true,
      presetId: true,
      updatedAt: true,
    },
  });
  return NextResponse.json({ items: projects });
}

export const GET = withApi(handleGET);
export const POST = withApi(handlePOST);
