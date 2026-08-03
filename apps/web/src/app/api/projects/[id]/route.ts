import { NextRequest, NextResponse } from "next/server";
import { apiError, safeParseEditSpec } from "@reelforge/shared";
import { prisma } from "@/lib/db";
import { enqueueJob } from "@/lib/jobs";
import { apiSession } from "@/lib/session";
import { presignGet } from "@/lib/storage";
import { withApi } from "@/lib/with-api";

async function ownProject(id: string, userId: string) {
  const project = await prisma.project.findUnique({ where: { id } });
  if (!project || project.ownerId !== userId) return null;
  return project;
}

/** GET /api/projects/:id — project + latest preview render + active job. */
async function handleGET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { session, response } = await apiSession();
  if (response) return response;
  const { id } = await params;
  const project = await ownProject(id, session.user.id);
  if (!project) {
    return NextResponse.json(apiError("not_found", "Project not found"), { status: 404 });
  }

  const [latestRender, activeJob] = await Promise.all([
    prisma.job.findFirst({
      where: {
        type: { in: ["render_preview", "render_final"] },
        status: "done",
        payload: { path: ["projectId"], equals: id },
      },
      orderBy: { finishedAt: "desc" },
    }),
    prisma.job.findFirst({
      where: {
        type: { in: ["autoedit_generate", "render_preview", "render_final"] },
        status: { in: ["queued", "running"] },
        payload: { path: ["projectId"], equals: id },
      },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  const renderResult = latestRender?.result as { storageKey?: string; progress?: number } | null;
  const activeResult = activeJob?.result as { progress?: number } | null;
  const failedJob = activeJob
    ? null
    : await prisma.job.findFirst({
        where: {
          type: { in: ["autoedit_generate", "render_preview", "render_final"] },
          status: "failed",
          payload: { path: ["projectId"], equals: id },
          finishedAt: { gt: new Date(Date.now() - 10 * 60_000) },
        },
        orderBy: { finishedAt: "desc" },
      });

  return NextResponse.json({
    id: project.id,
    title: project.title,
    aspect: project.aspect,
    vibeId: project.vibeId,
    presetId: project.presetId,
    status: project.status,
    seed: project.seed,
    editSpec: project.editSpec,
    updatedAt: project.updatedAt,
    previewUrl: renderResult?.storageKey ? await presignGet(renderResult.storageKey) : null,
    activeJob: activeJob
      ? {
          id: activeJob.id,
          type: activeJob.type,
          status: activeJob.status,
          progress: activeResult?.progress ?? null,
        }
      : null,
    lastError: failedJob ? { type: failedJob.type, message: failedJob.error } : null,
  });
}

/** PATCH /api/projects/:id {editSpec} — validate, save, enqueue preview render (§5.4). */
async function handlePATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { session, response } = await apiSession();
  if (response) return response;
  const { id } = await params;
  const project = await ownProject(id, session.user.id);
  if (!project) {
    return NextResponse.json(apiError("not_found", "Project not found"), { status: 404 });
  }

  // an in-flight autoedit will overwrite whatever we save — reject the write
  const activeAutoedit = await prisma.job.findFirst({
    where: {
      type: "autoedit_generate",
      status: { in: ["queued", "running"] },
      payload: { path: ["projectId"], equals: id },
    },
    select: { id: true },
  });
  if (activeAutoedit) {
    return NextResponse.json(
      apiError("autoedit_in_progress", "An auto-edit is running; retry when it finishes"),
      { status: 409 },
    );
  }

  const body = (await req.json().catch(() => null)) as {
    editSpec?: unknown;
    render?: boolean;
  } | null;
  const result = safeParseEditSpec(body?.editSpec);
  if (!result.success) {
    return NextResponse.json(
      apiError("invalid_edit_spec", result.error.issues[0]?.message ?? "Invalid edit spec"),
      { status: 400 },
    );
  }

  // every referenced asset must belong to the caller (or be a seeded music track)
  const videoAssetIds = new Set<string>();
  const audioAssetIds = new Set<string>();
  for (const track of result.data.tracks) {
    if (track.type === "video") for (const clip of track.clips) videoAssetIds.add(clip.assetId);
    if (track.type === "audio") for (const clip of track.clips) audioAssetIds.add(clip.assetId);
  }
  const [ownedMedia, allowedMusic] = await Promise.all([
    prisma.mediaAsset.findMany({
      where: { id: { in: [...videoAssetIds, ...audioAssetIds] }, ownerId: session.user.id },
      select: { id: true },
    }),
    prisma.musicTrack.findMany({
      where: {
        id: { in: [...audioAssetIds] },
        OR: [{ ownerId: null }, { ownerId: session.user.id }],
      },
      select: { id: true },
    }),
  ]);
  const allowed = new Set([...ownedMedia.map((a) => a.id), ...allowedMusic.map((t) => t.id)]);
  const unowned = [...videoAssetIds, ...audioAssetIds].filter((assetId) => !allowed.has(assetId));
  if (unowned.length > 0) {
    return NextResponse.json(apiError("forbidden_asset", "Edit references media you don't own"), {
      status: 403,
    });
  }

  await prisma.project.update({
    where: { id },
    data: { editSpec: result.data as object, status: body?.render ? "rendering" : project.status },
  });
  let jobId: string | null = null;
  if (body?.render) {
    jobId = await enqueueJob(
      "render_preview",
      { projectId: id },
      { ownerId: session.user.id, priority: 3 },
    );
  }
  return NextResponse.json({ ok: true, jobId });
}

export const GET = withApi(handleGET);
export const PATCH = withApi(handlePATCH);
