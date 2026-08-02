import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiError } from "@reelforge/shared";
import { prisma } from "@/lib/db";
import { apiAdmin } from "@/lib/session";

/** GET/POST /api/admin/flags — feature flag store (SPEC §4 FeatureFlag). */
export async function GET() {
  const { response } = await apiAdmin();
  if (response) return response;
  const flags = await prisma.featureFlag.findMany();
  return NextResponse.json({ flags });
}

const BodySchema = z.object({ key: z.string().min(1).max(64), value: z.unknown() });

export async function POST(req: NextRequest) {
  const { response } = await apiAdmin();
  if (response) return response;
  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(apiError("bad_request", "key + value required"), { status: 400 });
  }
  const flag = await prisma.featureFlag.upsert({
    where: { key: parsed.data.key },
    create: { key: parsed.data.key, value: parsed.data.value as object },
    update: { value: parsed.data.value as object },
  });
  return NextResponse.json({ flag });
}
