import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { apiSession } from "@/lib/session";
import { withApi } from "@/lib/with-api";

/** GET /api/models — active gen model routing table (slugs stay server-side only). */
async function handleGET() {
  const { response } = await apiSession();
  if (response) return response;
  const models = await prisma.genModel.findMany({ where: { active: true } });
  return NextResponse.json({
    models: models.map((m) => ({
      id: m.id,
      kind: m.kind,
      tier: m.tier,
      creditPerUnit: m.creditPerUnit,
      unit: m.unit,
      active: m.active,
    })),
  });
}

export const GET = withApi(handleGET);
