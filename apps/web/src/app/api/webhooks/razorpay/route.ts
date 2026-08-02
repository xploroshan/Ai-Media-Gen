import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@reelforge/shared";
import { paymentsProvider } from "@/lib/payments";

/**
 * Razorpay webhook stub (SPEC §9). Live payments are out of scope for v1 —
 * plans are toggled by admins. This route exists as the integration seam.
 */
export async function POST(req: NextRequest) {
  // TODO(Razorpay stub): verify signature, apply plan change, return 200
  const parsed = await paymentsProvider.parseWebhook(
    await req.text(),
    req.headers.get("x-razorpay-signature") ?? "",
  );
  if (!parsed) {
    return NextResponse.json(apiError("not_implemented", "Payments are not enabled in v1"), {
      status: 501,
    });
  }
  return NextResponse.json({ ok: true });
}
