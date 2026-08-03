import path from "node:path";
import { expect, test } from "@playwright/test";
import { signInWithOtp, uniqueEmail } from "../helpers/auth";

const FIXTURES = path.join(__dirname, "..", "fixtures");
const SIX = ["img1.jpg", "img2.jpg", "img3.jpg", "img4.jpg", "vid1.mp4", "vid2.mp4"];

test.describe("P1 — media library", () => {
  test("upload 6 fixtures → all ready, thumbs render, event appears", async ({ page }) => {
    test.setTimeout(360_000); // NFR §13: analyzed ≤90s for 6 fixtures; generous bound incl. upload
    const email = uniqueEmail("p1-upload");
    await signInWithOtp(page, email);

    await page.getByTestId("upload-input").setInputFiles(SIX.map((f) => path.join(FIXTURES, f)));

    // analyzing banner normally shows while jobs run; tolerate a fast pipeline
    // finishing before we can observe it (appearance is best-effort, the
    // DISAPPEARANCE below is the real assertion)
    const sawBanner = await page
      .getByTestId("analyzing-banner")
      .waitFor({ state: "visible", timeout: 20_000 })
      .then(() => true)
      .catch(() => false);

    // all six analyzed → thumbs rendered, banner gone
    await expect(page.getByTestId("media-thumb")).toHaveCount(6, { timeout: 240_000 });
    await expect(page.getByTestId("analyzing-banner")).toHaveCount(0, { timeout: 60_000 });
    test.info().annotations.push({ type: "note", description: `sawAnalyzingBanner=${sawBanner}` });

    // thumbs actually painted (poll: <img> may exist before pixels decode)
    await expect
      .poll(
        async () =>
          page
            .getByTestId("media-thumb")
            .evaluateAll((imgs) => imgs.every((img) => (img as HTMLImageElement).naturalWidth > 0)),
        { timeout: 30_000 },
      )
      .toBe(true);

    // event auto-clustered from EXIF/creation_time (all within 2026-07-15, < 4h gaps)
    await expect(page.getByTestId("event-card")).toHaveCount(1, { timeout: 120_000 });
    await expect(page.getByTestId("event-card")).toContainText("(6)");

    // event filter narrows the grid to its members
    await page.getByTestId("event-card").click();
    await expect(page.getByTestId("media-thumb")).toHaveCount(6);

    // search by filename narrows results
    await page.getByLabel("Search media").fill("vid1");
    await expect(page.getByTestId("media-thumb")).toHaveCount(1, { timeout: 20_000 });
    await page.getByLabel("Search media").clear();

    // asset drawer shows analysis (quality + tags)
    await expect(page.getByTestId("media-thumb")).toHaveCount(6, { timeout: 20_000 });
    await page.getByLabel("img1.jpg").click();
    await expect(page.getByTestId("asset-drawer")).toBeVisible();
    await expect(page.getByTestId("quality-score")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("asset-tags")).toBeVisible();
  });
});
