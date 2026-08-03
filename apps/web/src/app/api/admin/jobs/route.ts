import { NextRequest, NextResponse } from "next/server";
import { apiAdmin } from "@/lib/session";
import { prisma } from "@/lib/db";
import { withApi } from "@/lib/with-api";

/** GET /api/admin/jobs?status= — jobs dashboard feed (SPEC §0.1 item 9). */
async function handleGET(req: NextRequest) {
  const { response } = await apiAdmin();
  if (response) return response;
  const status = req.nextUrl.searchParams.get("status") ?? undefined;
  const jobs = await prisma.job.findMany({
    where: status ? { status } : {},
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  const counts = await prisma.job.groupBy({ by: ["status"], _count: true });
  return NextResponse.json({
    counts: Object.fromEntries(counts.map((c) => [c.status, c._count])),
    jobs: jobs.map((j) => ({
      id: j.id,
      type: j.type,
      status: j.status,
      attempts: j.attempts,
      ownerId: j.ownerId,
      error: j.error,
      createdAt: j.createdAt,
      finishedAt: j.finishedAt,
    })),
  });
}

export const GET = withApi(handleGET);
