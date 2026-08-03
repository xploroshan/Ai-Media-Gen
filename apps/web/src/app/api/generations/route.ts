import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { apiSession } from "@/lib/session";
import { presignGet } from "@/lib/storage";
import { withApi } from "@/lib/with-api";

/** GET /api/generations — history with result thumbnails (SPEC §5.4). */
async function handleGET(req: NextRequest) {
  const { session, response } = await apiSession();
  if (response) return response;
  const page = Math.max(1, Number(req.nextUrl.searchParams.get("page") ?? 1) || 1);

  const generations = await prisma.generation.findMany({
    where: { ownerId: session.user.id },
    orderBy: { createdAt: "desc" },
    skip: (page - 1) * 30,
    take: 30,
  });

  // batch the lookups: one query per table for the whole page, not per row
  const genResults = generations.map((gen) => {
    const params = (gen.params ?? {}) as { results?: string[]; error?: string };
    return {
      gen,
      params,
      resultIds: params.results ?? (gen.resultAssetId ? [gen.resultAssetId] : []),
    };
  });
  const musicIds = genResults.filter((g) => g.gen.kind === "music").flatMap((g) => g.resultIds);
  const assetIds = genResults.filter((g) => g.gen.kind !== "music").flatMap((g) => g.resultIds);
  const [tracks, assets] = await Promise.all([
    musicIds.length
      ? prisma.musicTrack.findMany({ where: { id: { in: musicIds } } })
      : Promise.resolve([]),
    assetIds.length
      ? prisma.mediaAsset.findMany({ where: { id: { in: assetIds } } })
      : Promise.resolve([]),
  ]);
  const trackById = new Map(tracks.map((t) => [t.id, t]));
  const assetById = new Map(assets.map((a) => [a.id, a]));

  const items = await Promise.all(
    genResults.map(async ({ gen, params, resultIds }) => {
      const results = await Promise.all(
        resultIds.map(async (assetId) => {
          if (gen.kind === "music") {
            const track = trackById.get(assetId);
            return track
              ? {
                  assetId,
                  kind: "music",
                  title: track.title,
                  url: await presignGet(track.storageKey),
                  thumbUrl: null,
                }
              : null;
          }
          const asset = assetById.get(assetId);
          if (!asset) return null;
          return {
            assetId,
            kind: asset.kind,
            title: asset.filename,
            url: await presignGet(asset.storageKey),
            thumbUrl: asset.thumbKey ? await presignGet(asset.thumbKey) : null,
          };
        }),
      );
      return {
        id: gen.id,
        kind: gen.kind,
        prompt: gen.prompt,
        status: gen.status,
        creditCost: gen.creditCost,
        createdAt: gen.createdAt,
        chosenAssetId: gen.resultAssetId,
        bestOf2: Boolean((gen.params as { bestOf2?: boolean } | null)?.bestOf2),
        error: params.error ?? null,
        results: results.filter(Boolean),
      };
    }),
  );
  return NextResponse.json({ items });
}

export const GET = withApi(handleGET);
