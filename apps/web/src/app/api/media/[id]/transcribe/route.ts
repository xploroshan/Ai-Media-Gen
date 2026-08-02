import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiError } from "@reelforge/shared";
import { prisma } from "@/lib/db";
import { enqueueJob } from "@/lib/jobs";
import { apiSession } from "@/lib/session";

const BodySchema = z.object({ lang: z.enum(["en", "hi"]).optional() }).default({});

/** POST /api/media/:id/transcribe — enqueue faster-whisper transcription (SPEC §5.2). */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { session, response } = await apiSession();
  if (response) return response;
  const { id } = await params;
  const asset = await prisma.mediaAsset.findUnique({ where: { id } });
  if (!asset || asset.ownerId !== session.user.id) {
    return NextResponse.json(apiError("not_found", "Asset not found"), { status: 404 });
  }
  if (asset.kind === "image") {
    return NextResponse.json(apiError("bad_request", "Images have no audio to transcribe"), {
      status: 400,
    });
  }

  const pending = await prisma.job.findFirst({
    where: {
      type: "transcribe",
      status: { in: ["queued", "running"] },
      payload: { path: ["assetId"], equals: id },
    },
  });
  if (pending) return NextResponse.json({ jobId: pending.id, deduped: true });

  const body = BodySchema.parse(await req.json().catch(() => ({})));
  const jobId = await enqueueJob(
    "transcribe",
    { assetId: id, ...(body.lang ? { lang: body.lang } : {}) },
    { ownerId: session.user.id, priority: 4 },
  );
  return NextResponse.json({ jobId });
}
