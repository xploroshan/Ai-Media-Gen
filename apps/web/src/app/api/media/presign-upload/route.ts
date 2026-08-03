import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { MEDIA_KINDS, apiError } from "@reelforge/shared";
import { prisma } from "@/lib/db";
import { apiSession } from "@/lib/session";
import { BUCKETS, MULTIPART_THRESHOLD, presignPut, startMultipart } from "@/lib/storage";
import { withApi } from "@/lib/with-api";

const BodySchema = z.object({
  filename: z.string().min(1).max(255),
  bytes: z.number().int().positive().max(2_147_483_647), // int4 column bound (a 2 GiB upload would overflow it)
  kind: z.enum(MEDIA_KINDS),
  contentType: z.string().optional(),
});

const EXT_RE = /\.([A-Za-z0-9]{1,8})$/;

async function handlePOST(req: NextRequest) {
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

  // presign BEFORE inserting the row — a storage failure must not strand a
  // 'uploading' asset row pointing at a key that will never exist
  const assetId = crypto.randomUUID().replace(/-/g, "").slice(0, 25);
  const storageKey = `${BUCKETS.originals}/${session.user.id}/${assetId}.${ext}`;
  const upload =
    bytes >= MULTIPART_THRESHOLD
      ? { multipart: await startMultipart(storageKey, bytes, contentType) }
      : { uploadUrl: await presignPut(storageKey, contentType) };

  await prisma.mediaAsset.create({
    data: {
      id: assetId,
      ownerId: session.user.id,
      kind,
      status: "uploading",
      storageKey,
      filename,
      bytes,
    },
  });
  return NextResponse.json({ assetId, ...upload });
}

export const POST = withApi(handlePOST);
