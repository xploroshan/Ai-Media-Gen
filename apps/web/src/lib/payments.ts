/**
 * PaymentsProvider interface — SPEC §0.2/§9: live payments are OUT of scope for
 * v1. Plans are feature flags toggled by an admin; this interface + the
 * Razorpay webhook stub are the integration seam for a later build.
 */

export type CheckoutSession = { url: string; providerRef: string };

export interface PaymentsProvider {
  /** Create a checkout session that upgrades `userId` to `plan`. */
  createCheckout(userId: string, plan: "creator" | "business"): Promise<CheckoutSession>;
  /** Verify + parse an incoming webhook; returns the plan change to apply. */
  parseWebhook(
    rawBody: string,
    signature: string,
  ): Promise<{ userId: string; plan: string } | null>;
}

/** Razorpay adapter — TODO: implement when live payments are in scope (post-v1). */
export class RazorpayStubProvider implements PaymentsProvider {
  async createCheckout(): Promise<CheckoutSession> {
    throw new Error("Payments are not enabled in this build — ask an admin to change your plan.");
  }

  async parseWebhook(): Promise<null> {
    return null; // TODO(Razorpay stub): verify X-Razorpay-Signature and map payload
  }
}

export const paymentsProvider: PaymentsProvider = new RazorpayStubProvider();
