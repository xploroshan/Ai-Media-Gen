import { NextResponse } from "next/server";
import { PLAN_LIMITS, type Plan } from "@reelforge/shared";
import { maybeMonthlyGrant } from "@/lib/credits";
import { prisma } from "@/lib/db";
import { apiSession } from "@/lib/session";

/** GET /api/credits — balance + recent ledger. Applies the lazy monthly grant (§9). */
export async function GET() {
  const { session, response } = await apiSession();
  if (response) return response;

  const profile = await prisma.profile.findUnique({ where: { id: session.user.id } });
  if (profile) {
    const limits = PLAN_LIMITS[(profile.plan as Plan) ?? "free"] ?? PLAN_LIMITS.free;
    await maybeMonthlyGrant(session.user.id, limits.monthlyCredits);
  }
  const [fresh, ledger] = await Promise.all([
    prisma.profile.findUnique({ where: { id: session.user.id } }),
    prisma.creditLedger.findMany({
      where: { ownerId: session.user.id },
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
  ]);
  return NextResponse.json({
    balance: fresh?.creditsBalance ?? 0,
    plan: fresh?.plan ?? "free",
    ledger: ledger.map((row) => ({
      id: row.id,
      delta: row.delta,
      reason: row.reason,
      refId: row.refId,
      balanceAfter: row.balanceAfter,
      createdAt: row.createdAt,
    })),
  });
}
