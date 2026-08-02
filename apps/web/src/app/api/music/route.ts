import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { apiSession } from "@/lib/session";

/** GET /api/music — library seed tracks + the user's own audio uploads. */
export async function GET() {
  const { session, response } = await apiSession();
  if (response) return response;
  const [seedTracks, ownAudio] = await Promise.all([
    prisma.musicTrack.findMany({
      where: { OR: [{ ownerId: null }, { ownerId: session.user.id }] },
    }),
    prisma.mediaAsset.findMany({
      where: { ownerId: session.user.id, kind: "audio", status: "ready" },
      select: { id: true, filename: true, durationSec: true },
    }),
  ]);
  return NextResponse.json({
    tracks: seedTracks.map((t) => ({
      id: t.id,
      title: t.title,
      durationSec: t.durationSec,
      license: t.license,
      source: "library" as const,
    })),
    uploads: ownAudio.map((a) => ({
      id: a.id,
      title: a.filename,
      durationSec: a.durationSec,
      source: "upload" as const,
    })),
  });
}
