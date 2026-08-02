import { NextResponse } from "next/server";
import { apiError } from "@reelforge/shared";
import { prisma } from "@/lib/db";
import { apiSession } from "@/lib/session";
import { presignGet } from "@/lib/storage";

/** GET /api/media/:id — asset detail for the drawer. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { session, response } = await apiSession();
  if (response) return response;
  const { id } = await params;

  const asset = await prisma.mediaAsset.findUnique({ where: { id }, include: { analysis: true } });
  if (!asset || asset.ownerId !== session.user.id) {
    return NextResponse.json(apiError("not_found", "Asset not found"), { status: 404 });
  }
  return NextResponse.json({
    id: asset.id,
    kind: asset.kind,
    status: asset.status,
    filename: asset.filename,
    bytes: asset.bytes,
    width: asset.width,
    height: asset.height,
    durationSec: asset.durationSec,
    fps: asset.fps,
    takenAt: asset.takenAt,
    gpsLat: asset.gpsLat,
    gpsLng: asset.gpsLng,
    synthetic: asset.synthetic,
    eventId: asset.eventId,
    phash: asset.phash,
    thumbUrl: asset.thumbKey ? await presignGet(asset.thumbKey) : null,
    originalUrl: await presignGet(asset.storageKey),
    proxyUrl: asset.proxyKey ? await presignGet(asset.proxyKey) : null,
    analysis: asset.analysis
      ? {
          qualityScore: asset.analysis.qualityScore,
          blurVar: asset.analysis.blurVar,
          exposureScore: asset.analysis.exposureScore,
          tags: asset.analysis.tags,
          facesCount: asset.analysis.facesCount,
          faceAreaRatio: asset.analysis.faceAreaRatio,
          sceneCuts: asset.analysis.sceneCuts,
          highlights: asset.analysis.highlights,
          beatTimes: asset.analysis.beatTimes,
        }
      : null,
  });
}
