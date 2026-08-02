import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiError } from "@reelforge/shared";
import { prisma } from "@/lib/db";
import { apiAdmin } from "@/lib/session";

/** GET /api/admin/models — full routing table incl. slugs (admin only, SPEC §8.2). */
export async function GET() {
  const { response } = await apiAdmin();
  if (response) return response;
  const models = await prisma.genModel.findMany({ orderBy: [{ kind: "asc" }, { tier: "asc" }] });
  return NextResponse.json({ models });
}

const UpsertSchema = z.object({
  id: z.string().optional(),
  kind: z.string().min(1),
  tier: z.string().min(1),
  providerId: z.string().min(1).default("fal"),
  modelSlug: z.string().min(1),
  creditPerUnit: z.number().int().positive(),
  unit: z.string().min(1),
  active: z.boolean().default(true),
});

/** POST /api/admin/models — create/update a routing row (slug edits live here, never in code). */
export async function POST(req: NextRequest) {
  const { response } = await apiAdmin();
  if (response) return response;
  const parsed = UpsertSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      apiError("bad_request", parsed.error.issues[0]?.message ?? "Invalid body"),
      { status: 400 },
    );
  }
  const { id, ...data } = parsed.data;
  const model = id
    ? await prisma.genModel.update({ where: { id }, data })
    : await prisma.genModel.upsert({
        where: { kind_tier: { kind: data.kind, tier: data.tier } },
        create: data,
        update: data,
      });
  return NextResponse.json({ model });
}
