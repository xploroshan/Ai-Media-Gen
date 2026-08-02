import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { PLANS, apiError } from "@reelforge/shared";
import { adminAdjustCredits } from "@/lib/credits";
import { prisma } from "@/lib/db";
import { apiAdmin } from "@/lib/session";

/** GET /api/admin/users?query= — find users for plan/credit management. */
export async function GET(req: NextRequest) {
  const { response } = await apiAdmin();
  if (response) return response;
  const query = req.nextUrl.searchParams.get("query")?.trim() ?? "";
  const users = await prisma.user.findMany({
    where: query ? { email: { contains: query, mode: "insensitive" } } : {},
    take: 20,
    orderBy: { createdAt: "desc" },
  });
  const profiles = await prisma.profile.findMany({
    where: { id: { in: users.map((u) => u.id) } },
  });
  const byId = new Map(profiles.map((p) => [p.id, p]));
  return NextResponse.json({
    users: users.map((u) => ({
      id: u.id,
      email: u.email,
      plan: byId.get(u.id)?.plan ?? "free",
      creditsBalance: byId.get(u.id)?.creditsBalance ?? 0,
      isAdmin: byId.get(u.id)?.isAdmin ?? false,
    })),
  });
}

const BodySchema = z.object({
  userId: z.string().min(1),
  plan: z.enum(PLANS).optional(),
  creditDelta: z.number().int().optional(),
});

/** POST /api/admin/users — set plan and/or adjust credits (ledgered, SPEC §9). */
export async function POST(req: NextRequest) {
  const { session, response } = await apiAdmin();
  if (response) return response;
  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success || (!parsed.data.plan && !parsed.data.creditDelta)) {
    return NextResponse.json(apiError("bad_request", "plan or creditDelta required"), {
      status: 400,
    });
  }
  const { userId, plan, creditDelta } = parsed.data;
  const profile = await prisma.profile.findUnique({ where: { id: userId } });
  if (!profile) {
    return NextResponse.json(apiError("not_found", "Profile not found"), { status: 404 });
  }
  if (plan) {
    await prisma.profile.update({ where: { id: userId }, data: { plan } });
  }
  let balance = profile.creditsBalance;
  if (creditDelta) {
    balance = await adminAdjustCredits(userId, creditDelta, `admin:${session.user.id}`);
  }
  return NextResponse.json({ ok: true, plan: plan ?? profile.plan, creditsBalance: balance });
}
