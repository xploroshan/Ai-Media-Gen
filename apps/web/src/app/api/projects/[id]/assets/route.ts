import { NextResponse } from "next/server";
import { apiError, type EditSpec } from "@reelforge/shared";
import { prisma } from "@/lib/db";
import { apiSession } from "@/lib/session";
import { presignGet } from "@/lib/storage";
import { withApi } from "@/lib/with-api";

/** GET /api/projects/:id/assets — media URLs for every asset referenced by the edit-spec. */
async function handleGET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { session, response } = await apiSession();
  if (response) return response;
  const { id } = await params;
  const project = await prisma.project.findUnique({ where: { id } });
  if (!project || project.ownerId !== session.user.id) {
    return NextResponse.json(apiError("not_found", "Project not found"), { status: 404 });
  }

  const spec = project.editSpec as unknown as EditSpec;
  const assetIds = new Set<string>();
  for (const track of spec.tracks ?? []) {
    if (track.type === "video") for (const clip of track.clips) assetIds.add(clip.assetId);
    if (track.type === "audio") for (const clip of track.clips) assetIds.add(clip.assetId);
  }

  const assets = await prisma.mediaAsset.findMany({
    where: { id: { in: [...assetIds] }, ownerId: session.user.id },
  });
  const musicTracks = await prisma.musicTrack.findMany({
    where: {
      id: { in: [...assetIds] },
      OR: [{ ownerId: null }, { ownerId: session.user.id }],
    },
  });

  const out: Record<
    string,
    { kind: string; url: string; posterUrl?: string; durationSec: number | null }
  > = {};
  for (const asset of assets) {
    const key = asset.kind === "video" && asset.proxyKey ? asset.proxyKey : asset.storageKey;
    out[asset.id] = {
      kind: asset.kind,
      url: await presignGet(key),
      posterUrl: asset.thumbKey ? await presignGet(asset.thumbKey) : undefined,
      durationSec: asset.durationSec,
    };
  }
  for (const track of musicTracks) {
    out[track.id] = {
      kind: "music",
      url: await presignGet(track.storageKey),
      durationSec: track.durationSec,
    };
  }
  return NextResponse.json({ assets: out });
}

export const GET = withApi(handleGET);
