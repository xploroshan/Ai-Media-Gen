import { expect, test } from "@playwright/test";
import { signInWithOtp, uniqueEmail } from "../helpers/auth";
import { uploadFixture, waitForReady } from "../helpers/media";

/** PNG color type lives at fixed offset in the IHDR chunk: 6 = RGBA. */
function pngColorType(bytes: Buffer): number {
  expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  return bytes[25]!;
}

test.describe("P6 — image studio", () => {
  test("bg-remove fixture → alpha PNG derived asset in library", async ({ page }) => {
    test.setTimeout(600_000);
    const email = uniqueEmail("p6-bgremove");
    await signInWithOtp(page, email);

    const assetId = await uploadFixture(page, "subject.png");
    await waitForReady(page, [assetId]);

    await page.goto("/images");
    await page.getByTestId("pick-image-subject.png").click();
    await page.getByTestId("op-bg_remove").click();
    await expect(page.getByTestId("op-success")).toBeVisible({ timeout: 300_000 });

    // derived asset exists, is a new asset (original untouched), and is RGBA PNG
    const mediaRes = await page.request.get("/api/media");
    const { items } = (await mediaRes.json()) as {
      items: { id: string; filename: string; status: string }[];
    };
    const derived = items.find((i) => i.filename.includes("bg_remove"));
    expect(derived, "derived bg_remove asset should exist").toBeTruthy();
    expect(derived!.id).not.toBe(assetId);

    const detailRes = await page.request.get(`/api/media/${derived!.id}`);
    const detail = (await detailRes.json()) as { originalUrl: string };
    const fileRes = await page.request.get(detail.originalUrl);
    expect(fileRes.ok()).toBeTruthy();
    const bytes = Buffer.from(await fileRes.body());
    expect(pngColorType(bytes)).toBe(6); // RGBA — alpha channel present

    // original is untouched and still ready
    const origRes = await page.request.get(`/api/media/${assetId}`);
    expect(((await origRes.json()) as { status: string }).status).toBe("ready");
  });

  test("enhance produces a new derived image", async ({ page }) => {
    test.setTimeout(600_000);
    const email = uniqueEmail("p6-enhance");
    await signInWithOtp(page, email);

    const assetId = await uploadFixture(page, "img1.jpg");
    await waitForReady(page, [assetId]);

    await page.goto("/images");
    await page.getByTestId("pick-image-img1.jpg").click();
    await page.getByTestId("op-enhance").click();
    await expect(page.getByTestId("op-success")).toBeVisible({ timeout: 300_000 });

    const mediaRes = await page.request.get("/api/media");
    const { items } = (await mediaRes.json()) as { items: { filename: string }[] };
    expect(items.some((i) => i.filename.includes("enhance"))).toBe(true);
  });

  test("erase with painted mask completes", async ({ page }) => {
    test.setTimeout(600_000);
    const email = uniqueEmail("p6-erase");
    await signInWithOtp(page, email);

    const assetId = await uploadFixture(page, "subject.png");
    await waitForReady(page, [assetId]);

    await page.goto("/images");
    await page.getByTestId("pick-image-subject.png").click();
    await page.getByTestId("op-erase").click();
    await expect(page.getByTestId("erase-canvas")).toBeVisible();

    // paint a stroke across the middle of the canvas
    const canvas = page.locator("[data-testid=erase-canvas] canvas");
    const box = (await canvas.boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.5);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5, { steps: 8 });
    await page.mouse.up();

    await page.getByTestId("apply-erase").click();
    await expect(page.getByTestId("op-success")).toBeVisible({ timeout: 300_000 });

    const mediaRes = await page.request.get("/api/media");
    const { items } = (await mediaRes.json()) as { items: { filename: string }[] };
    expect(items.some((i) => i.filename.includes("erase"))).toBe(true);
  });
});
