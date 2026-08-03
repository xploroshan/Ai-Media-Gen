import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@reelforge/shared";
import { paymentsProvider } from "@/lib/payments";
import { withApi } from "@/lib/with-api";

/**
 * Razorpay webhook stub (SPEC §9). Live payments are out of scope for v1 —
 * plans are toggled by admins. This route exists as the integration seam.
 */
async function handlePOST(req: NextRequest) {
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

export const POST = withApi(handlePOST);
