import { NextResponse } from "next/server";
import { apiError } from "@reelforge/shared";
import { prisma } from "@/lib/db";
import { apiSession } from "@/lib/session";

/** GET /api/jobs/:id — poll job status (SPEC §5.4); 2 s client polling while active. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { session, response } = await apiSession();
  if (response) return response;
  const { id } = await params;
  const job = await prisma.job.findUnique({ where: { id } });
  if (!job || (job.ownerId && job.ownerId !== session.user.id)) {
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
