import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { signInWithOtp, uniqueEmail } from "../helpers/auth";
import { uploadFixture, waitForReady } from "../helpers/media";

/** PNG color type lives at fixed offset in the IHDR chunk: 6 = RGBA. */
function pngColorType(bytes: Buffer): number {
  expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  return bytes[25]!;
}

/** Decode image bytes in the browser (data URLs are canvas-safe) and sample
 * RGBA at fractional coordinates. Returns [r,g,b,a] per point. */
async function samplePixels(
  page: Page,
  bytes: Buffer,
  mime: string,
  points: [number, number][],
): Promise<[number, number, number, number][]> {
  return page.evaluate(
    async ({ b64, mime, points }) => {
      const img = new Image();
      img.src = `data:${mime};base64,${b64}`;
      await img.decode();
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(img, 0, 0);
      return points.map(([fx, fy]) => {
        const x = Math.min(canvas.width - 1, Math.round(fx * canvas.width));
        const y = Math.min(canvas.height - 1, Math.round(fy * canvas.height));
        const d = ctx.getImageData(x, y, 1, 1).data;
        return [d[0]!, d[1]!, d[2]!, d[3]!] as [number, number, number, number];
      });
    },
    { b64: bytes.toString("base64"), mime, points },
  );
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

    // transparency is REAL, not just a declared channel: the green background
    // corners are cut out while the red disc at the center stays opaque
    const [tl, tr, bl, br, center] = await samplePixels(page, bytes, "image/png", [
      [0.03, 0.03],
      [0.97, 0.03],
      [0.03, 0.97],
      [0.97, 0.97],
      [0.5, 0.5],
    ]);
    for (const corner of [tl!, tr!, bl!, br!]) {
      expect(corner[3], "background corner should be transparent").toBeLessThan(40);
    }
    expect(center![3], "subject center should stay opaque").toBeGreaterThan(200);

    // original is untouched and still ready; derived analyzes to ready
    const origRes = await page.request.get(`/api/media/${assetId}`);
    expect(((await origRes.json()) as { status: string }).status).toBe("ready");
    await expect
      .poll(
        async () => {
          const res = await page.request.get(`/api/media/${derived!.id}`);
          return ((await res.json()) as { status: string }).status;
        },
        { timeout: 120_000 },
      )
      .toBe("ready");
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

    // paint a stroke through the small white inner circle (center ~42%,42%)
    // so the inpainted region has a strong before/after color change
    const canvas = page.locator("[data-testid=erase-canvas] canvas");
    const box = (await canvas.boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.35, box.y + box.height * 0.42);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.42, { steps: 10 });
    await page.mouse.up();

    await page.getByTestId("apply-erase").click();
    await expect(page.getByTestId("op-success")).toBeVisible({ timeout: 300_000 });

    const mediaRes = await page.request.get("/api/media");
    const { items } = (await mediaRes.json()) as {
      items: { id: string; filename: string }[];
    };
    const derived = items.find((i) => i.filename.includes("erase"));
    expect(derived, "derived erase asset should exist").toBeTruthy();

    // the inpainted result must actually differ from the original along the
    // painted stroke (horizontal band through the middle of the disc)
    const origBytes = Buffer.from(
      await (
        await page.request.get(
          (
            (await (await page.request.get(`/api/media/${assetId}`)).json()) as {
              originalUrl: string;
            }
          ).originalUrl,
        )
      ).body(),
    );
    const derivedDetail = (await (await page.request.get(`/api/media/${derived!.id}`)).json()) as {
      originalUrl: string;
    };
    const derivedBytes = Buffer.from(
      await (await page.request.get(derivedDetail.originalUrl)).body(),
    );
    // sample inside the white inner circle — after inpainting it should no
    // longer be white (LaMa fills from the surrounding red disc)
    const strokePoints: [number, number][] = [
      [0.41, 0.42],
      [0.42, 0.42],
      [0.43, 0.42],
    ];
    const before = await samplePixels(page, origBytes, "image/png", strokePoints);
    const after = await samplePixels(page, derivedBytes, "image/png", strokePoints);
    const diff = before.reduce((acc, b, i) => {
      const a = after[i]!;
      return acc + Math.abs(b[0] - a[0]) + Math.abs(b[1] - a[1]) + Math.abs(b[2] - a[2]);
    }, 0);
    expect(diff, "painted region should be visibly inpainted").toBeGreaterThan(100);

    // derived asset finishes analysis
    await expect
      .poll(
        async () => {
          const res = await page.request.get(`/api/media/${derived!.id}`);
          return ((await res.json()) as { status: string }).status;
        },
        { timeout: 120_000 },
      )
      .toBe("ready");
  });
});
