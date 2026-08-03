import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { GEN_KINDS, apiError } from "@reelforge/shared";
import { InsufficientCreditsError, spendForGeneration } from "@/lib/credits";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { computeCost } from "@/lib/gen-cost";
import { SAFETY_BLOCK_MESSAGE, isPromptBlocked } from "@/lib/safety";
import { apiSession } from "@/lib/session";
import { presignGet } from "@/lib/storage";
import { withApi } from "@/lib/with-api";

const BodySchema = z.object({
  kind: z.enum(GEN_KINDS),
  tier: z.string().min(1).default("standard"),
  prompt: z.string().min(1).max(2000),
  bestOf2: z.boolean().optional(), // accepted top-level too; merged into params
  params: z
    .object({
      aspect: z.enum(["square", "portrait", "landscape"]).optional(),
      durationSec: z.number().min(3).max(8).optional(),
      imageAssetId: z.string().optional(),
      voice: z.string().optional(),
      bestOf2: z.boolean().optional(),
    })
    .catchall(z.unknown())
    .default({}),
});

/** POST /api/generate — credit check → generation + job (SPEC §5.4, §8.4). */
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
  const { kind, tier, prompt } = parsed.data;
  const params = {
    ...parsed.data.params,
    ...(parsed.data.bestOf2 !== undefined ? { bestOf2: parsed.data.bestOf2 } : {}),
  };

  if (isPromptBlocked(prompt)) {
    return NextResponse.json(apiError("prompt_blocked", SAFETY_BLOCK_MESSAGE), { status: 422 });
  }
  if (params.bestOf2 && kind !== "t2v") {
    return NextResponse.json(apiError("bad_request", "Best-of-2 is a text-to-video option"), {
      status: 400,
    });
  }

  const model = await prisma.genModel.findFirst({ where: { kind, tier, active: true } });
  if (!model) {
    return NextResponse.json(apiError("no_model", `No active model for ${kind}/${tier}`), {
      status: 400,
    });
  }

  // i2v needs a source image the caller owns
  const extraParams: Record<string, unknown> = { ...params, safety: { blocked: false } };
  if (kind === "i2v") {
    if (!params.imageAssetId) {
      return NextResponse.json(apiError("bad_request", "imageAssetId required for image→video"), {
        status: 400,
      });
    }
    const image = await prisma.mediaAsset.findUnique({ where: { id: params.imageAssetId } });
    if (!image || image.ownerId !== session.user.id || image.kind !== "image") {
      return NextResponse.json(apiError("bad_request", "Source image not found"), { status: 400 });
    }
    // the provider needs a fetchable URL for the source image
    extraParams.imageUrl = await presignGet(image.storageKey, 3600 * 12);
  }

  const cost = computeCost(model.creditPerUnit, model.unit, prompt, params);
  const providerId = env.FAL_KEY ? "fal" : "stub";

  try {
    const result = await spendForGeneration({
      ownerId: session.user.id,
      cost,
      kind,
      providerId,
      modelSlug: model.modelSlug,
      prompt,
      params: extraParams as object,
    });
    return NextResponse.json({ ...result, cost });
  } catch (err) {
    if (err instanceof InsufficientCreditsError) {
      return NextResponse.json(
        apiError("insufficient_credits", `You need ${err.cost} credits but have ${err.balance}.`),
        { status: 402 },
      );
    }
    throw err;
  }
}

export const POST = withApi(handlePOST);
