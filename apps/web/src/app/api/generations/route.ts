import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { apiSession } from "@/lib/session";
import { presignGet } from "@/lib/storage";

/** GET /api/generations — history with result thumbnails (SPEC §5.4). */
export async function GET(req: NextRequest) {
  const { session, response } = await apiSession();
  if (response) return response;
  const page = Math.max(1, Number(req.nextUrl.searchParams.get("page") ?? 1) || 1);

  const generations = await prisma.generation.findMany({
    where: { ownerId: session.user.id },
    orderBy: { createdAt: "desc" },
    skip: (page - 1) * 30,
    take: 30,
  });

  const items = await Promise.all(
    generations.map(async (gen) => {
      const params = (gen.params ?? {}) as { results?: string[]; error?: string };
      const resultIds: string[] = params.results ?? (gen.resultAssetId ? [gen.resultAssetId] : []);
      const results = await Promise.all(
        resultIds.map(async (assetId) => {
          if (gen.kind === "music") {
            const track = await prisma.musicTrack.findUnique({ where: { id: assetId } });
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
          const asset = await prisma.mediaAsset.findUnique({ where: { id: assetId } });
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
