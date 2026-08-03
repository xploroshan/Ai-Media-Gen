import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { apiSession } from "@/lib/session";
import { presignGet } from "@/lib/storage";
import { withApi } from "@/lib/with-api";

const PAGE_SIZE = 60;

/** GET /api/media?query=&eventId=&kind=&from=&to=&page= — library grid (SPEC §5.4). */
async function handleGET(req: NextRequest) {
  const { session, response } = await apiSession();
  if (response) return response;

  const q = req.nextUrl.searchParams;
  const query = q.get("query")?.trim() ?? "";
  const eventId = q.get("eventId") ?? undefined;
  const kind = q.get("kind") ?? undefined;
  const from = q.get("from") ? new Date(q.get("from")!) : undefined;
  const to = q.get("to") ? new Date(q.get("to")!) : undefined;
  const page = Math.max(1, Number(q.get("page") ?? 1) || 1);

  const where: Prisma.MediaAssetWhereInput = {
    ownerId: session.user.id,
    ...(eventId ? { eventId } : {}),
    ...(kind ? { kind } : {}),
    ...(from || to
      ? { takenAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } }
      : {}),
  };
  if (query) {
    where.OR = [
      { filename: { contains: query, mode: "insensitive" } },
      // tag search: JSON array of {label,score} — string_contains on the serialized JSON
      { analysis: { is: { tags: { string_contains: query.toLowerCase() } } } },
    ];
  }

  const [total, assets] = await Promise.all([
    prisma.mediaAsset.count({ where }),
    prisma.mediaAsset.findMany({
      where,
      include: { analysis: { select: { qualityScore: true, tags: true, facesCount: true } } },
      orderBy: [{ takenAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
  ]);

  const items = await Promise.all(
    assets.map(async (a) => ({
      id: a.id,
      kind: a.kind,
      status: a.status,
      filename: a.filename,
      width: a.width,
      height: a.height,
      durationSec: a.durationSec,
      takenAt: a.takenAt,
      synthetic: a.synthetic,
      eventId: a.eventId,
      createdAt: a.createdAt,
      thumbUrl: a.thumbKey ? await presignGet(a.thumbKey) : null,
      qualityScore: a.analysis?.qualityScore ?? null,
      tags: (a.analysis?.tags as { label: string; score: number }[] | null) ?? [],
      facesCount: a.analysis?.facesCount ?? null,
    })),
  );

  return NextResponse.json({ items, total, page, pageSize: PAGE_SIZE });
}

export const GET = withApi(handleGET);
