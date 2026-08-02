import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { MEDIA_KINDS, apiError } from "@reelforge/shared";
import { prisma } from "@/lib/db";
import { apiSession } from "@/lib/session";
import { BUCKETS, MULTIPART_THRESHOLD, presignPut, startMultipart } from "@/lib/storage";

const BodySchema = z.object({
  filename: z.string().min(1).max(255),
  bytes: z
    .number()
    .int()
    .positive()
    .max(2 * 1024 * 1024 * 1024),
  kind: z.enum(MEDIA_KINDS),
  contentType: z.string().optional(),
});

const EXT_RE = /\.([A-Za-z0-9]{1,8})$/;

export async function POST(req: NextRequest) {
  const { session, response } = await apiSession();
  if (response) return response;

  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      apiError("bad_request", parsed.error.issues[0]?.message ?? "Invalid body"),
      {
        status: 400,
      },
    );
  }
  const { filename, bytes, kind, contentType } = parsed.data;
  const ext = EXT_RE.exec(filename)?.[1]?.toLowerCase() ?? "bin";

  const asset = await prisma.mediaAsset.create({
    data: {
      ownerId: session.user.id,
      kind,
      status: "uploading",
      storageKey: "pending",
      filename,
      bytes,
    },
  });
  const storageKey = `${BUCKETS.originals}/${session.user.id}/${asset.id}.${ext}`;
  await prisma.mediaAsset.update({ where: { id: asset.id }, data: { storageKey } });

  if (bytes >= MULTIPART_THRESHOLD) {
    const multipart = await startMultipart(storageKey, bytes, contentType);
    return NextResponse.json({ assetId: asset.id, multipart });
  }
  const uploadUrl = await presignPut(storageKey, contentType);
  return NextResponse.json({ assetId: asset.id, uploadUrl });
}
