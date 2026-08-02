import { Prisma } from "@prisma/client";
import { prisma } from "./db";

/**
 * Atomic credit spend — SPEC §8.4. Single DB transaction:
 * SELECT balance FOR UPDATE → insufficient ⇒ error → ledger row (delta<0,
 * balanceAfter) → balance update → Generation + Job rows.
 * The ledger is append-only; replaying it must always equal the balance.
 */

export class InsufficientCreditsError extends Error {
  constructor(
    public balance: number,
    public cost: number,
  ) {
    super(`Insufficient credits: need ${cost}, have ${balance}`);
  }
}

export type SpendForGenerationInput = {
  ownerId: string;
  cost: number;
  kind: string;
  providerId: string;
  modelSlug: string;
  prompt: string;
  params: Prisma.InputJsonValue;
};

export async function spendForGeneration(input: SpendForGenerationInput): Promise<{
  generationId: string;
  jobId: string;
  balanceAfter: number;
}> {
  if (!Number.isInteger(input.cost) || input.cost <= 0) {
    throw new Error(`invalid credit cost ${input.cost}`);
  }
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ credits_balance: number }[]>`
      SELECT credits_balance FROM profiles WHERE id = ${input.ownerId} FOR UPDATE`;
    const balance = rows[0]?.credits_balance;
    if (balance === undefined) throw new Error("profile not found");
    if (balance < input.cost) throw new InsufficientCreditsError(balance, input.cost);

    const balanceAfter = balance - input.cost;
    const generation = await tx.generation.create({
      data: {
        ownerId: input.ownerId,
        kind: input.kind,
        providerId: input.providerId,
        modelSlug: input.modelSlug,
        prompt: input.prompt,
        params: input.params,
        creditCost: input.cost,
        status: "queued",
      },
    });
    await tx.creditLedger.create({
      data: {
        ownerId: input.ownerId,
        delta: -input.cost,
        reason: "generation",
        refId: generation.id,
        balanceAfter,
      },
    });
    await tx.profile.update({
      where: { id: input.ownerId },
      data: { creditsBalance: balanceAfter },
    });
    const job = await tx.job.create({
      data: {
        type: "generate_ai",
        payload: { generationId: generation.id },
        ownerId: input.ownerId,
        priority: 5,
      },
    });
    await tx.generation.update({ where: { id: generation.id }, data: { jobId: job.id } });
    return { generationId: generation.id, jobId: job.id, balanceAfter };
  });
}

/** Admin credit adjustment — same ledger discipline (reason=admin_adjust). */
export async function adminAdjustCredits(
  ownerId: string,
  delta: number,
  refId?: string,
): Promise<number> {
  if (!Number.isInteger(delta) || delta === 0) throw new Error("delta must be a non-zero integer");
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ credits_balance: number }[]>`
      SELECT credits_balance FROM profiles WHERE id = ${ownerId} FOR UPDATE`;
    const balance = rows[0]?.credits_balance;
    if (balance === undefined) throw new Error("profile not found");
    const balanceAfter = Math.max(0, balance + delta);
    await tx.creditLedger.create({
      data: {
        ownerId,
        delta: balanceAfter - balance,
        reason: "admin_adjust",
        refId,
        balanceAfter,
      },
    });
    await tx.profile.update({ where: { id: ownerId }, data: { creditsBalance: balanceAfter } });
    return balanceAfter;
  });
}

/** Monthly lazy grant (SPEC §9): top up to plan allowance on first request of a month. */
export async function maybeMonthlyGrant(ownerId: string, monthlyCredits: number): Promise<void> {
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  await prisma.$transaction(async (tx) => {
    const granted = await tx.creditLedger.findFirst({
      where: { ownerId, reason: "monthly_grant", createdAt: { gte: monthStart } },
    });
    if (granted) return;
    const rows = await tx.$queryRaw<{ credits_balance: number }[]>`
      SELECT credits_balance FROM profiles WHERE id = ${ownerId} FOR UPDATE`;
    const balance = rows[0]?.credits_balance;
    if (balance === undefined || balance >= monthlyCredits) return;
    await tx.creditLedger.create({
      data: {
        ownerId,
        delta: monthlyCredits - balance,
        reason: "monthly_grant",
        balanceAfter: monthlyCredits,
      },
    });
    await tx.profile.update({
      where: { id: ownerId },
      data: { creditsBalance: monthlyCredits },
    });
  });
}
