import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiError } from "@reelforge/shared";
import { prisma } from "@/lib/db";
import { apiSession } from "@/lib/session";
import { withApi } from "@/lib/with-api";

const BodySchema = z.object({ assetId: z.string().min(1) });

/** POST /api/generations/:id/pick — Best-of-2: user keeps one take (SPEC §8.3). */
async function handlePOST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { session, response } = await apiSession();
  if (response) return response;
  const { id } = await params;

  const gen = await prisma.generation.findUnique({ where: { id } });
  if (!gen || gen.ownerId !== session.user.id) {
    return NextResponse.json(apiError("not_found", "Generation not found"), { status: 404 });
  }
  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(apiError("bad_request", "assetId required"), { status: 400 });
  }
  const genParams = (gen.params ?? {}) as { results?: string[] };
  const results = genParams.results ?? [];
  if (!results.includes(parsed.data.assetId)) {
    return NextResponse.json(apiError("bad_request", "Asset is not a take of this generation"), {
      status: 400,
    });
  }

  // atomic: only the first pick lands — a second concurrent pick gets 409
  const updated = await prisma.generation.updateMany({
    where: { id, ownerId: session.user.id, resultAssetId: null, status: "done" },
    data: { resultAssetId: parsed.data.assetId, params: { ...genParams, picked: true } },
  });
  if (updated.count === 0) {
    return NextResponse.json(apiError("conflict", "Take already picked"), { status: 409 });
  }
  return NextResponse.json({ ok: true, chosen: parsed.data.assetId });
}

export const POST = withApi(handlePOST);
