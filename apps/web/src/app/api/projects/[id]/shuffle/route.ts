import { NextRequest, NextResponse } from "next/server";
import { apiError, SteeringSchema, type EditSpec } from "@reelforge/shared";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { enqueueJob } from "@/lib/jobs";
import { apiSession } from "@/lib/session";

const BodySchema = z.object({ steering: SteeringSchema.optional() }).default({});

/** POST /api/projects/:id/shuffle — new seed + autoedit job with exclusion set (§6.4.8). */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { session, response } = await apiSession();
  if (response) return response;
  const { id } = await params;
  const project = await prisma.project.findUnique({ where: { id } });
  if (!project || project.ownerId !== session.user.id) {
    return NextResponse.json(apiError("not_found", "Project not found"), { status: 404 });
  }
  if (!project.vibeId || !project.presetId) {
    return NextResponse.json(apiError("conflict", "Project has no auto-edit yet"), { status: 409 });
  }

  const body = BodySchema.parse(await req.json().catch(() => ({})));
  const spec = project.editSpec as unknown as EditSpec;
  const videoTrack = spec.tracks?.find?.((t) => t.type === "video");
  const priorAssetIds = [
    ...new Set(videoTrack?.type === "video" ? videoTrack.clips.map((c) => c.assetId) : []),
  ];
  const durationSec = spec.durationSec ?? 20;

  // same candidate set as the original auto-edit (last autoedit job's payload)
  const lastAutoedit = await prisma.job.findFirst({
    where: { type: "autoedit_generate", payload: { path: ["projectId"], equals: id } },
    orderBy: { createdAt: "desc" },
  });
  let candidateIds = (lastAutoedit?.payload as { assetIds?: string[] } | null)?.assetIds;
  if (!candidateIds?.length) {
    const all = await prisma.mediaAsset.findMany({
      where: { ownerId: session.user.id, status: "ready", kind: { in: ["image", "video"] } },
      select: { id: true },
    });
    candidateIds = all.map((a) => a.id);
  }

  const seed = Math.floor(Math.random() * 2 ** 31);
  await prisma.project.update({ where: { id }, data: { seed, status: "rendering" } });
  const jobId = await enqueueJob(
    "autoedit_generate",
    {
      projectId: id,
      assetIds: candidateIds,
      vibeId: project.vibeId,
      presetId: project.presetId,
      targetSec: durationSec,
      seed,
      steering: body.steering,
      excludeAssetIds: priorAssetIds,
    },
    { ownerId: session.user.id, priority: 3 },
  );
  return NextResponse.json({ jobId, seed });
}
