import { NextResponse } from "next/server";
import { apiError, type EditSpec } from "@reelforge/shared";
import { prisma } from "@/lib/db";
import { apiSession } from "@/lib/session";
import { presignGet } from "@/lib/storage";
import { withApi } from "@/lib/with-api";

/** GET /api/exports/:id — status, download URL, share caption (SPEC §9). */
async function handleGET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { session, response } = await apiSession();
  if (response) return response;
  const { id } = await params;
  const exportRow = await prisma.export.findUnique({ where: { id } });
  if (!exportRow || exportRow.ownerId !== session.user.id) {
    return NextResponse.json(apiError("not_found", "Export not found"), { status: 404 });
  }

  const project = await prisma.project.findUnique({ where: { id: exportRow.projectId } });
  const spec = project?.editSpec as unknown as EditSpec | undefined;
  const assetIds = spec?.tracks?.find((t) => t.type === "video")?.clips.map((c) => c.assetId) ?? [];
  const [syntheticCount, analyses] = await Promise.all([
    prisma.mediaAsset.count({ where: { id: { in: assetIds }, synthetic: true } }),
    prisma.mediaAnalysis.findMany({
      where: { assetId: { in: assetIds } },
      select: { tags: true },
    }),
  ]);

  // template caption: title + 5 hashtag suggestions from CLIP tags (SPEC §9)
  // LLM-HOOK: an AI caption/hashtag generator would replace this template
  const tagScores = new Map<string, number>();
  for (const analysis of analyses) {
    for (const tag of (analysis.tags as { label: string; score: number }[] | null) ?? []) {
      tagScores.set(tag.label, Math.max(tagScores.get(tag.label) ?? 0, tag.score));
    }
  }
  const hashtags = [...tagScores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([label]) => `#${label.replace(/[^a-z0-9]+/gi, "")}`);
  const caption = [project?.title ?? "My reel", "", ...hashtags].join("\n").trim();

  return NextResponse.json({
    id: exportRow.id,
    status: exportRow.status,
    resolution: exportRow.resolution,
    watermark: exportRow.watermark,
    presetId: exportRow.presetId,
    ffprobe: exportRow.ffprobe,
    downloadUrl: exportRow.storageKey ? await presignGet(exportRow.storageKey) : null,
    containsSynthetic: syntheticCount > 0,
    caption,
  });
}

export const GET = withApi(handleGET);
