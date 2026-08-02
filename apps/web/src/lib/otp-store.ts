/**
 * Dev-only in-memory OTP store backing GET /api/dev/last-otp (DECISIONS.md #5).
 * Never populated when a real email provider (RESEND_API_KEY) is configured.
 */
const globalStore = globalThis as unknown as { __otpStore?: Map<string, string> };

function store(): Map<string, string> {
  globalStore.__otpStore ??= new Map();
  return globalStore.__otpStore;
}

export function rememberOtp(email: string, otp: string): void {
  store().set(email.toLowerCase(), otp);
}

export function lastOtpFor(email: string): string | undefined {
  return store().get(email.toLowerCase());
}
