import { expect, type Page } from "@playwright/test";

/** Sign up / sign in through the OTP flow using the dev OTP readback endpoint. */
export async function signInWithOtp(page: Page, email: string): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email address").fill(email);
  await page.getByRole("button", { name: "Send sign-in code" }).click();
  const codeInput = page.getByRole("textbox", { name: "Code", exact: true });
  await expect(codeInput).toBeVisible();

  const res = await page.request.get(`/api/dev/last-otp?email=${encodeURIComponent(email)}`);
  expect(res.ok(), "dev OTP endpoint must return the issued code").toBeTruthy();
  const { otp } = (await res.json()) as { otp: string };

  await codeInput.fill(otp);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/library");
}

export function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@e2e.local`;
}
