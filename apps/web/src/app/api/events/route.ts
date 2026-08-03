import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { apiSession } from "@/lib/session";
import { presignGet } from "@/lib/storage";
import { withApi } from "@/lib/with-api";

/** GET /api/events — clustered events with cover thumbs (SPEC §5.4). */
async function handleGET() {
  const { session, response } = await apiSession();
  if (response) return response;

  const events = await prisma.event.findMany({
    where: { ownerId: session.user.id },
    orderBy: { startAt: "desc" },
    take: 200,
  });

  // one covers query for the whole page instead of one per event
  const allAssetIds = [...new Set(events.flatMap((e) => (e.assetIds as string[]) ?? []))];
  const covers = allAssetIds.length
    ? await prisma.mediaAsset.findMany({
        where: { id: { in: allAssetIds }, thumbKey: { not: null } },
        select: { id: true, thumbKey: true },
      })
    : [];
  const thumbByAsset = new Map(covers.map((c) => [c.id, c.thumbKey!]));

  const items = await Promise.all(
    events.map(async (event) => {
      const assetIds = (event.assetIds as string[]) ?? [];
      const coverThumb = assetIds.map((id) => thumbByAsset.get(id)).find(Boolean);
      return {
        id: event.id,
        title: event.title,
        startAt: event.startAt,
        endAt: event.endAt,
        assetCount: assetIds.length,
        coverUrl: coverThumb ? await presignGet(coverThumb) : null,
      };
    }),
  );
  return NextResponse.json({ items });
}

export const GET = withApi(handleGET);
