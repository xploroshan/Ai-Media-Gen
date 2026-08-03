import { NextResponse } from "next/server";
import { apiError } from "@reelforge/shared";
import { prisma } from "@/lib/db";
import { apiSession } from "@/lib/session";
import { withApi } from "@/lib/with-api";

/** GET /api/jobs/:id — poll job status (SPEC §5.4); 2 s client polling while active. */
async function handleGET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { session, response } = await apiSession();
  if (response) return response;
  const { id } = await params;
  const job = await prisma.job.findUnique({ where: { id } });
  // null-owner jobs are system jobs — not readable through the per-user endpoint
  if (!job || job.ownerId !== session.user.id) {
    return NextResponse.json(apiError("not_found", "Job not found"), { status: 404 });
  }
  const result = (job.result ?? {}) as Record<string, unknown>;
  return NextResponse.json({
    id: job.id,
    type: job.type,
    status: job.status,
    progress: typeof result.progress === "number" ? result.progress : undefined,
    result: job.status === "done" ? result : undefined,
    error: job.status === "failed" ? job.error : undefined,
  });
}

export const GET = withApi(handleGET);
