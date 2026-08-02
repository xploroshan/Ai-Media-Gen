import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { NextResponse } from "next/server";
import { apiError } from "@reelforge/shared";
import { auth } from "./auth";
import { prisma } from "./db";

/** Server-component guard: returns session or redirects to /login. */
export async function requireSession() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/login");
  return session;
}

/** API-route guard: returns {session} or a 401 response. */
export async function apiSession(): Promise<
  | { session: NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>; response?: never }
  | { session?: never; response: NextResponse }
> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return {
      response: NextResponse.json(apiError("unauthorized", "Sign in required"), { status: 401 }),
    };
  }
  return { session };
}

export async function requireAdmin() {
  const session = await requireSession();
  const profile = await prisma.profile.findUnique({ where: { id: session.user.id } });
  if (!profile?.isAdmin) redirect("/library");
  return { session, profile };
}
