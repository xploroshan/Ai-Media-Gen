import { JOB_PAYLOAD_SCHEMAS, type JobType } from "@reelforge/shared";
import { prisma } from "./db";

/** Enqueue a worker job (web↔worker communicate ONLY via the jobs table, SPEC §1). */
export async function enqueueJob(
  type: JobType,
  payload: unknown,
  opts: { ownerId?: string; priority?: number } = {},
): Promise<string> {
  const parsed = JOB_PAYLOAD_SCHEMAS[type].parse(payload);
  const job = await prisma.job.create({
    data: {
      type,
      payload: parsed as object,
      ownerId: opts.ownerId,
      priority: opts.priority ?? 5,
    },
  });
  return job.id;
}
