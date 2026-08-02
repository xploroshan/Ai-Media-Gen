import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@reelforge/shared";
import { isDevAuth } from "@/lib/env";
import { lastOtpFor } from "@/lib/otp-store";

/** Dev/test-only OTP readback (DECISIONS.md #5). 404s whenever real email is configured. */
export function GET(req: NextRequest) {
  if (!isDevAuth) {
    return NextResponse.json(apiError("not_found", "Not found"), { status: 404 });
  }
  const email = req.nextUrl.searchParams.get("email");
  if (!email) {
    return NextResponse.json(apiError("bad_request", "email query param required"), {
      status: 400,
    });
  }
  const otp = lastOtpFor(email);
  if (!otp) {
    return NextResponse.json(apiError("not_found", "No OTP issued for this email"), {
      status: 404,
    });
  }
  return NextResponse.json({ otp });
}
