import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { apiError } from "@reelforge/shared";

/**
 * Route-handler wrapper enforcing the error envelope (CLAUDE.md conventions):
 * every uncaught error becomes `{error:{code,message}}` — ZodError → 400,
 * anything else → 500 (logged, message not leaked).
 */
export function withApi<Args extends unknown[]>(
  handler: (...args: Args) => Promise<Response>,
): (...args: Args) => Promise<Response> {
  return async (...args: Args) => {
    try {
      return await handler(...args);
    } catch (err) {
      if (err instanceof ZodError) {
        return NextResponse.json(
          apiError("bad_request", err.issues[0]?.message ?? "Invalid input"),
          { status: 400 },
        );
      }
      console.error("[api] unhandled error:", err);
      return NextResponse.json(apiError("internal", "Something went wrong"), { status: 500 });
    }
  };
}
