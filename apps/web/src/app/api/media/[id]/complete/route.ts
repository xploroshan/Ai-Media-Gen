import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiError } from "@reelforge/shared";
import { prisma } from "@/lib/db";
import { enqueueJob } from "@/lib/jobs";
import { apiSession } from "@/lib/session";
import { completeMultipart, objectExists } from "@/lib/storage";

const BodySchema = z
  .object({
    multipart: z
      .object({
        uploadId: z.string(),
        parts: z.array(z.object({ PartNumber: z.number().int(), ETag: z.string() })),
      })
      .optional(),
  })
  .default({});

/** POST /api/media/:id/complete — finalize upload, enqueue analyze (+beats for audio). */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { session, response } = await apiSession();
  if (response) return response;
  const { id } = await params;

  const asset = await prisma.mediaAsset.findUnique({ where: { id } });
  if (!asset || asset.ownerId !== session.user.id) {
    return NextResponse.json(apiError("not_found", "Asset not found"), { status: 404 });
  }
  if (asset.status !== "uploading") {
    return NextResponse.json(apiError("conflict", `Asset is ${asset.status}`), { status: 409 });
  }

  const body = BodySchema.parse(await req.json().catch(() => ({})));
  if (body.multipart) {
    await completeMultipart(asset.storageKey, body.multipart.uploadId, body.multipart.parts);
  }
  if (!(await objectExists(asset.storageKey))) {
    return NextResponse.json(apiError("upload_incomplete", "Object not found in storage"), {
      status: 400,
    });
  }

  await prisma.mediaAsset.update({ where: { id }, data: { status: "analyzing" } });
  const jobId = await enqueueJob(
    "analyze_media",
    { assetId: id },
    { ownerId: session.user.id, priority: 4 },
  );
  if (asset.kind === "audio") {
    await enqueueJob("beats", { assetId: id }, { ownerId: session.user.id, priority: 6 });
  }
  return NextResponse.json({ ok: true, jobId });
}
