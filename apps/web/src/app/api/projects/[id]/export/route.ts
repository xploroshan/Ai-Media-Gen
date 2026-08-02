import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { PLAN_LIMITS, RESOLUTIONS, apiError, type EditSpec, type Plan } from "@reelforge/shared";
import { prisma } from "@/lib/db";
import { enqueueJob } from "@/lib/jobs";
import { apiSession } from "@/lib/session";

const BodySchema = z.object({
  presetId: z.string().min(1),
  resolution: z.enum(RESOLUTIONS),
});

/** POST /api/projects/:id/export — plan-gated export + render_final (SPEC §5.4, §9). */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { session, response } = await apiSession();
  if (response) return response;
  const { id } = await params;
  const project = await prisma.project.findUnique({ where: { id } });
  if (!project || project.ownerId !== session.user.id) {
    return NextResponse.json(apiError("not_found", "Project not found"), { status: 404 });
  }

  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      apiError("bad_request", parsed.error.issues[0]?.message ?? "Invalid body"),
      { status: 400 },
    );
  }
  const { presetId, resolution } = parsed.data;

  const preset = await prisma.platformPreset.findUnique({ where: { id: presetId } });
  if (!preset) {
    return NextResponse.json(apiError("bad_request", "Unknown preset"), { status: 400 });
  }
  const spec = project.editSpec as unknown as EditSpec;
  if (spec.durationSec > preset.maxSec) {
    return NextResponse.json(
      apiError(
        "preset_cap",
        `This project is ${Math.round(spec.durationSec)}s but ${preset.name} allows at most ${preset.maxSec}s.`,
      ),
      { status: 400 },
    );
  }

  const profile = await prisma.profile.findUnique({ where: { id: session.user.id } });
  const limits = PLAN_LIMITS[(profile?.plan as Plan) ?? "free"] ?? PLAN_LIMITS.free;
  if (resolution === "1080p" && limits.maxResolution !== "1080p") {
    return NextResponse.json(
      apiError("plan_gate", "1080p export needs the Creator plan — free exports are 720p."),
      { status: 403 },
    );
  }

  const exportRow = await prisma.export.create({
    data: {
      projectId: id,
      ownerId: session.user.id,
      presetId,
      resolution,
      watermark: limits.watermark, // free plan burns the watermark (SPEC §9)
      status: "queued",
    },
  });
  const jobId = await enqueueJob(
    "render_final",
    { projectId: id, exportId: exportRow.id },
    { ownerId: session.user.id, priority: 3 },
  );

  // synthetic-content disclosure reminder (SPEC §8.3; C2PA out of scope)
  const assetIds = spec.tracks?.find((t) => t.type === "video")?.clips.map((c) => c.assetId) ?? [];
  const syntheticCount = await prisma.mediaAsset.count({
    where: { id: { in: assetIds }, synthetic: true },
  });
  // C2PA-HOOK: content-credential signing would attach here at export finalization

  return NextResponse.json({
    exportId: exportRow.id,
    jobId,
    watermark: limits.watermark,
    containsSynthetic: syntheticCount > 0,
  });
}
