import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { apiSession } from "@/lib/session";

/** GET /api/meta — vibes + platform presets for the create wizard. */
export async function GET() {
  const { response } = await apiSession();
  if (response) return response;
  const [vibes, presets] = await Promise.all([
    prisma.vibe.findMany({ orderBy: { sortOrder: "asc" } }),
    prisma.platformPreset.findMany(),
  ]);
  return NextResponse.json({ vibes, presets });
}
