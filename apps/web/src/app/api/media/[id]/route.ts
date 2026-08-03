import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiError } from "@reelforge/shared";
import { prisma } from "@/lib/db";
import { apiSession } from "@/lib/session";
import { abortMultipart, presignGet } from "@/lib/storage";
import { withApi } from "@/lib/with-api";

/** GET /api/media/:id — asset detail for the drawer. */
async function handleGET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
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
          transcript: asset.analysis.transcript,
        }
      : null,
  });
}

const DeleteBody = z.object({ uploadId: z.string().optional() }).default({});

/** DELETE /api/media/:id — abandon a failed/canceled upload (aborts multipart). */
async function handleDELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { session, response } = await apiSession();
  if (response) return response;
  const { id } = await params;

  const asset = await prisma.mediaAsset.findUnique({ where: { id } });
  if (!asset || asset.ownerId !== session.user.id) {
    return NextResponse.json(apiError("not_found", "Asset not found"), { status: 404 });
  }
  if (asset.status !== "uploading") {
    // only stranded uploads are deletable here — library deletion is out of scope
    return NextResponse.json(apiError("conflict", `Asset is ${asset.status}`), { status: 409 });
  }
  const body = DeleteBody.parse(await req.json().catch(() => ({})));
  if (body.uploadId) {
    await abortMultipart(asset.storageKey, body.uploadId).catch(() => {
      // already aborted/expired is fine — the row cleanup is what matters
    });
  }
  await prisma.mediaAsset.deleteMany({ where: { id, status: "uploading" } });
  return NextResponse.json({ ok: true });
}

export const GET = withApi(handleGET);
export const DELETE = withApi(handleDELETE);
