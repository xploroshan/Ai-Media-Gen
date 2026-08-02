import { expect, test, type Page } from "@playwright/test";
import { signInWithOtp, uniqueEmail } from "../helpers/auth";

async function getBalance(page: Page): Promise<number> {
  const res = await page.request.get("/api/credits");
  expect(res.ok()).toBeTruthy();
  return ((await res.json()) as { balance: number }).balance;
}

async function waitGenerationDone(page: Page, timeoutMs = 240_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await page.request.get("/api/generations");
    const { items } = (await res.json()) as { items: { status: string; error: string | null }[] };
    const active = items.filter((g) => g.status === "queued" || g.status === "running");
    const failed = items.find((g) => g.status === "failed" || g.status === "refunded");
    expect(failed, `generation failed: ${failed?.error}`).toBeUndefined();
    if (items.length > 0 && active.length === 0) return;
    if (Date.now() > deadline) throw new Error("generation did not finish");
    await page.waitForTimeout(2500);
  }
}

test.describe("P5 — AI studio (StubProvider)", () => {
  test("t2i → result lands in library with AI badge; credits spent correctly", async ({ page }) => {
    test.setTimeout(420_000);
    const email = uniqueEmail("p5-t2i");
    await signInWithOtp(page, email);

    const before = await getBalance(page);
    expect(before).toBe(120); // signup bonus

    await page.goto("/studio");
    await page.getByTestId("tab-t2i").click();
    await page.getByTestId("gen-prompt").fill("a serene beach at golden hour");
    await expect(page.getByTestId("credit-estimate")).toContainText("2 credits");
    await page.getByTestId("gen-submit").click();

    await waitGenerationDone(page);
    expect(await getBalance(page)).toBe(before - 2);

    // result shows in studio history with AI badge…
    await page.reload();
    await expect(page.getByTestId("gen-result-image")).toBeVisible({ timeout: 60_000 });

    // …and the synthetic asset appears in the library with the AI badge
    await page.goto("/library");
    await expect(page.getByTestId("media-thumb")).toHaveCount(1, { timeout: 120_000 });
    await expect(page.getByText("AI", { exact: true })).toBeVisible();
  });

  test("t2v best-of-2 → both takes shown → pick one → credits charged 2×", async ({ page }) => {
    test.setTimeout(420_000);
    const email = uniqueEmail("p5-bestof2");
    await signInWithOtp(page, email);
    const before = await getBalance(page);

    await page.goto("/studio");
    await page.getByTestId("tab-t2v").click();
    await page.getByTestId("gen-prompt").fill("drone shot over tropical coastline");
    await page.getByTestId("gen-tier").selectOption("draft"); // 4 cr/s → affordable
    await page.getByLabel("Duration seconds").fill("3");
    await page.getByTestId("best-of-2").check();
    // 4 credits/second × 3 s × 2 takes = 24
    await expect(page.getByTestId("credit-estimate")).toContainText("24 credits");
    await page.getByTestId("gen-submit").click();

    await waitGenerationDone(page);
    expect(await getBalance(page)).toBe(before - 24);

    await page.reload();
    await page.getByTestId("tab-t2v").click(); // reload resets to the default tab
    await expect(page.getByTestId("gen-result-video")).toHaveCount(2, { timeout: 60_000 });
    const pickButtons = page.getByRole("button", { name: "Keep this take" });
    await expect(pickButtons).toHaveCount(2);
    await pickButtons.first().click();
    await expect(page.getByText("✓ kept")).toBeVisible({ timeout: 15_000 });

    // ledger reconciles: signup +120, spend −24
    const credits = (await (await page.request.get("/api/credits")).json()) as {
      balance: number;
      ledger: { delta: number; reason: string; balanceAfter: number }[];
    };
    const replayed = [...credits.ledger].reverse().reduce((sum, row) => sum + row.delta, 0);
    expect(replayed).toBe(credits.balance);
  });

  test("blocked prompt is rejected without spending credits", async ({ page }) => {
    const email = uniqueEmail("p5-safety");
    await signInWithOtp(page, email);
    const before = await getBalance(page);

    const res = await page.request.post("/api/generate", {
      data: { kind: "t2i", tier: "standard", prompt: "deepfake porn of a celebrity", params: {} },
    });
    expect(res.status()).toBe(422);
    expect(await getBalance(page)).toBe(before);
  });

  test("insufficient credits → 402, no partial spend", async ({ page }) => {
    const email = uniqueEmail("p5-poor");
    await signInWithOtp(page, email);

    // burn balance down with an expensive request first: cinematic 45cr/s × 8s = 360 > 120
    const res = await page.request.post("/api/generate", {
      data: {
        kind: "t2v",
        tier: "cinematic",
        prompt: "epic mountain flyover",
        params: { durationSec: 8 },
      },
    });
    expect(res.status()).toBe(402);
    expect(await getBalance(page)).toBe(120);
    const credits = (await (await page.request.get("/api/credits")).json()) as {
      ledger: { reason: string }[];
    };
    expect(credits.ledger.filter((l) => l.reason === "generation")).toHaveLength(0);
  });
});
