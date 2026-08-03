import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { enqueueJob } from "@/lib/jobs";
import { apiSession } from "@/lib/session";
import { withApi } from "@/lib/with-api";

/** POST /api/events/detect — on-demand clustering (SPEC §6.2 "or on demand"). */
async function handlePOST() {
  const { session, response } = await apiSession();
  if (response) return response;

  const pending = await prisma.job.findFirst({
    where: {
      type: "detect_events",
      ownerId: session.user.id,
      status: { in: ["queued", "running"] },
    },
  });
  if (pending) return NextResponse.json({ jobId: pending.id, deduped: true });

  const jobId = await enqueueJob(
    "detect_events",
    { ownerId: session.user.id },
    { ownerId: session.user.id, priority: 6 },
  );
  return NextResponse.json({ jobId });
}

export const POST = withApi(handlePOST);
