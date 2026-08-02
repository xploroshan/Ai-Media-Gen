import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { IMAGE_OPS, apiError } from "@reelforge/shared";
import { prisma } from "@/lib/db";
import { enqueueJob } from "@/lib/jobs";
import { apiSession } from "@/lib/session";
import { BUCKETS, s3 } from "@/lib/storage";
import { PutObjectCommand } from "@aws-sdk/client-s3";

const BodySchema = z.object({
  op: z.enum(IMAGE_OPS),
  params: z
    .object({
      maskDataUrl: z.string().startsWith("data:image/png;base64,").max(8_000_000).optional(),
    })
    .default({}),
});

/** POST /api/images/:id/op — enqueue an image_op job (SPEC §5.4, §6.7). */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { session, response } = await apiSession();
  if (response) return response;
  const { id } = await params;

  const asset = await prisma.mediaAsset.findUnique({ where: { id } });
  if (!asset || asset.ownerId !== session.user.id) {
    return NextResponse.json(apiError("not_found", "Asset not found"), { status: 404 });
  }
  if (asset.kind !== "image" || asset.status !== "ready") {
    return NextResponse.json(apiError("bad_request", "A ready image asset is required"), {
      status: 400,
    });
  }

  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      apiError("bad_request", parsed.error.issues[0]?.message ?? "Invalid body"),
      { status: 400 },
    );
  }
  const { op } = parsed.data;

  const jobParams: Record<string, unknown> = {};
  if (op === "erase") {
    const dataUrl = parsed.data.params.maskDataUrl;
    if (!dataUrl) {
      return NextResponse.json(apiError("bad_request", "erase requires params.maskDataUrl"), {
        status: 400,
      });
    }
    const bytes = Buffer.from(dataUrl.split(",", 2)[1]!, "base64");
    const key = `masks/${session.user.id}/${id}-${Date.now()}.png`;
    await s3.send(
      new PutObjectCommand({
        Bucket: BUCKETS.derived,
        Key: key,
        Body: bytes,
        ContentType: "image/png",
      }),
    );
    jobParams.maskKey = `${BUCKETS.derived}/${key}`;
  }

  const jobId = await enqueueJob(
    "image_op",
    { assetId: id, op, params: jobParams },
    { ownerId: session.user.id, priority: 4 },
  );
  return NextResponse.json({ jobId });
}
