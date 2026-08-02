import { expect, test } from "@playwright/test";
import { signInWithOtp, uniqueEmail } from "../helpers/auth";

test.describe("P0 — auth + shell", () => {
  test("signup via email OTP lands in Library", async ({ page }) => {
    const email = uniqueEmail("p0-signup");
    await signInWithOtp(page, email);

    await expect(page).toHaveURL(/\/library/);
    await expect(page.getByRole("heading", { name: "Library" })).toBeVisible();
    // App shell nav is present
    await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
    await expect(page.getByRole("link", { name: "AI Studio" })).toBeVisible();
  });

  test("unauthenticated visit to /library redirects to login", async ({ page }) => {
    await page.goto("/library");
    await page.waitForURL("**/login");
    await expect(page.getByRole("button", { name: "Send sign-in code" })).toBeVisible();
  });

  test("wrong OTP is rejected", async ({ page }) => {
    const email = uniqueEmail("p0-wrongotp");
    await page.goto("/login");
    await page.getByLabel("Email address").fill(email);
    await page.getByRole("button", { name: "Send sign-in code" }).click();
    await page.getByRole("textbox", { name: "Code", exact: true }).fill("000000");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page).not.toHaveURL(/\/library/);
  });
});
