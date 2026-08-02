import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { apiSession } from "@/lib/session";
import { presignGet } from "@/lib/storage";

/** GET /api/events — clustered events with cover thumbs (SPEC §5.4). */
export async function GET() {
  const { session, response } = await apiSession();
  if (response) return response;

  const events = await prisma.event.findMany({
    where: { ownerId: session.user.id },
    orderBy: { startAt: "desc" },
  });

  const items = await Promise.all(
    events.map(async (event) => {
      const assetIds = (event.assetIds as string[]) ?? [];
      const cover = assetIds.length
        ? await prisma.mediaAsset.findFirst({
            where: { id: { in: assetIds }, thumbKey: { not: null } },
          })
        : null;
      return {
        id: event.id,
        title: event.title,
        startAt: event.startAt,
        endAt: event.endAt,
        assetCount: assetIds.length,
        coverUrl: cover?.thumbKey ? await presignGet(cover.thumbKey) : null,
      };
    }),
  );
  return NextResponse.json({ items });
}
