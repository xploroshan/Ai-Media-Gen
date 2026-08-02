import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { signInWithOtp, uniqueEmail } from "../helpers/auth";
import { uploadFixture, waitForReady } from "../helpers/media";

const MEDIA = ["img1.jpg", "img3.jpg", "extra1.jpg", "extra2.jpg"];

async function waitIdle(page: Page, projectId: string, timeoutMs = 300_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await page.request.get(`/api/projects/${projectId}`);
    const project = (await res.json()) as {
      activeJob: unknown;
      lastError: unknown;
      previewUrl: string | null;
    };
    expect(project.lastError, JSON.stringify(project.lastError)).toBeNull();
    if (!project.activeJob && project.previewUrl) return project;
    if (Date.now() > deadline) throw new Error("project never became ready");
    await page.waitForTimeout(2500);
  }
}

async function runExport(
  page: Page,
  projectId: string,
  presetId: string,
  resolution: string,
): Promise<{ exportId: string; downloadUrl: string; watermark: boolean; ffprobe: unknown }> {
  const res = await page.request.post(`/api/projects/${projectId}/export`, {
    data: { presetId, resolution },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  const { exportId } = (await res.json()) as { exportId: string };
  const deadline = Date.now() + 600_000;
  for (;;) {
    const stateRes = await page.request.get(`/api/exports/${exportId}`);
    const state = (await stateRes.json()) as {
      status: string;
      downloadUrl: string | null;
      watermark: boolean;
      ffprobe: unknown;
    };
    if (state.status === "done") {
      return {
        exportId,
        downloadUrl: state.downloadUrl!,
        watermark: state.watermark,
        ffprobe: state.ffprobe,
      };
    }
    expect(state.status, "export failed").not.toBe("failed");
    if (Date.now() > deadline) throw new Error("export timed out");
    await page.waitForTimeout(3000);
  }
}

async function download(page: Page, url: string, dest: string) {
  const res = await page.request.get(url);
  expect(res.ok()).toBeTruthy();
  writeFileSync(dest, Buffer.from(await res.body()));
}

function ffprobeDuration(file: string): number {
  const out = execFileSync("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "csv=p=0",
    file,
  ]);
  return Number(out.toString().trim());
}

/** Extract a normalized frame and compare corner vs center regions of two videos. */
function frameDiffStats(fileA: string, fileB: string, tmp: string) {
  for (const [file, name] of [
    [fileA, "a.png"],
    [fileB, "b.png"],
  ] as const) {
    execFileSync("ffmpeg", [
      "-y",
      "-v",
      "error",
      "-ss",
      "2",
      "-i",
      file,
      "-frames:v",
      "1",
      "-vf",
      "scale=540:960",
      path.join(tmp, name),
    ]);
  }
  const script = `
import json
from PIL import Image, ImageChops, ImageStat
a = Image.open(${JSON.stringify(path.join(tmp, "a.png"))}).convert("L")
b = Image.open(${JSON.stringify(path.join(tmp, "b.png"))}).convert("L")
w, h = a.size
diff = ImageChops.difference(a, b)
corner = ImageStat.Stat(diff.crop((int(w*0.80), int(h*0.90), w, h))).mean[0]
center = ImageStat.Stat(diff.crop((int(w*0.4), int(h*0.4), int(w*0.6), int(h*0.6)))).mean[0]
print(json.dumps({"corner": corner, "center": center}))
`;
  const out = execFileSync("python3", ["-c", script]);
  return JSON.parse(out.toString()) as { corner: number; center: number };
}

async function adminPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signInWithOtp(page, "demo@reelforge.local");
  return page;
}

test.describe("P7 — plans, export, admin, PWA", () => {
  test("free export watermarked; creator isn't (corner pixels differ); 1080p gated; admin credit adjust ledgers", async ({
    page,
    browser,
  }) => {
    test.setTimeout(900_000);
    const email = uniqueEmail("p7-plans");
    await signInWithOtp(page, email);

    const assetIds: string[] = [];
    for (const fixture of MEDIA) assetIds.push(await uploadFixture(page, fixture));
    await waitForReady(page, assetIds);

    const createRes = await page.request.post("/api/projects", {
      data: { assetIds, vibeId: "product-promo", presetId: "reel", targetSec: 10 },
    });
    const { projectId } = (await createRes.json()) as { projectId: string };
    await waitIdle(page, projectId);

    // free plan: 1080p is gated
    const gated = await page.request.post(`/api/projects/${projectId}/export`, {
      data: { presetId: "reel", resolution: "1080p" },
    });
    expect(gated.status()).toBe(403);

    // free 720p export → watermark on, outro appended
    const tmp = mkdtempSync(path.join(tmpdir(), "rf-p7-"));
    const freeExport = await runExport(page, projectId, "reel", "720p");
    expect(freeExport.watermark).toBe(true);
    const freePath = path.join(tmp, "free.mp4");
    await download(page, freeExport.downloadUrl, freePath);
    expect(ffprobeDuration(freePath)).toBeGreaterThan(11.1); // 10s + 1.5s outro

    // admin bumps this user to creator + adjusts credits (+50)
    const admin = await adminPage(browser);
    const usersRes = await admin.request.get(`/api/admin/users?query=${encodeURIComponent(email)}`);
    const { users } = (await usersRes.json()) as { users: { id: string; email: string }[] };
    const target = users.find((u) => u.email === email)!;
    const adminPost = await admin.request.post("/api/admin/users", {
      data: { userId: target.id, plan: "creator", creditDelta: 50 },
    });
    expect(adminPost.ok()).toBeTruthy();

    // credit adjust reflects in the user's ledger
    const credits = (await (await page.request.get("/api/credits")).json()) as {
      balance: number;
      ledger: { reason: string; delta: number; balanceAfter: number }[];
    };
    expect(credits.balance).toBe(170);
    const adjust = credits.ledger.find((l) => l.reason === "admin_adjust");
    expect(adjust?.delta).toBe(50);
    expect(adjust?.balanceAfter).toBe(170);

    // creator export at 1080p → no watermark, no outro
    const creatorExport = await runExport(page, projectId, "reel", "1080p");
    expect(creatorExport.watermark).toBe(false);
    const creatorPath = path.join(tmp, "creator.mp4");
    await download(page, creatorExport.downloadUrl, creatorPath);
    const creatorDuration = ffprobeDuration(creatorPath);
    expect(creatorDuration).toBeGreaterThan(9.7);
    expect(creatorDuration).toBeLessThan(10.4); // no outro

    // corner pixels differ (watermark) while center content matches
    const stats = frameDiffStats(freePath, creatorPath, tmp);
    expect(stats.corner).toBeGreaterThan(stats.center + 2);
    expect(stats.center).toBeLessThan(12); // same content baseline

    await admin.context().close();
  });

  test("preset caps are enforced on export", async ({ page }) => {
    test.setTimeout(600_000);
    const email = uniqueEmail("p7-caps");
    await signInWithOtp(page, email);
    const assetIds: string[] = [];
    for (const fixture of MEDIA.slice(0, 2)) assetIds.push(await uploadFixture(page, fixture));
    await waitForReady(page, assetIds);

    const createRes = await page.request.post("/api/projects", {
      data: { assetIds, vibeId: "product-promo", presetId: "story", targetSec: 500 },
    });
    expect(createRes.ok()).toBeTruthy();
    const { projectId } = (await createRes.json()) as { projectId: string };
    // targetSec is clamped to the preset max at creation (story: 60)
    const project = (await (await page.request.get(`/api/projects/${projectId}`)).json()) as {
      editSpec: { durationSec: number };
    };
    expect(project.editSpec.durationSec).toBeLessThanOrEqual(60);

    // a spec longer than the preset cap is rejected at export time
    const longSpec = structuredClone(project.editSpec) as {
      durationSec: number;
      tracks: { type: string; clips: Record<string, unknown>[] }[];
    };
    const video = longSpec.tracks.find((t) => t.type === "video")!;
    video.clips = [
      {
        id: "c1",
        assetId: assetIds[0],
        kind: "image",
        timelineStart: 0,
        duration: 90,
        speed: 1,
        transform: { scale: 1, x: 0, y: 0, rotate: 0 },
      },
    ];
    longSpec.durationSec = 90;
    const patchRes = await page.request.patch(`/api/projects/${projectId}`, {
      data: { editSpec: longSpec },
    });
    expect(patchRes.ok()).toBeTruthy();
    const capRes = await page.request.post(`/api/projects/${projectId}/export`, {
      data: { presetId: "story", resolution: "720p" },
    });
    expect(capRes.status()).toBe(400);
    const body = (await capRes.json()) as { error: { code: string } };
    expect(body.error.code).toBe("preset_cap");
  });

  test("PWA manifest and service worker are served", async ({ page }) => {
    const manifest = await page.request.get("/manifest.json");
    expect(manifest.ok()).toBeTruthy();
    const data = (await manifest.json()) as { name: string; icons: unknown[] };
    expect(data.name).toBe("ReelForge");
    expect(data.icons.length).toBeGreaterThan(0);
    const sw = await page.request.get("/sw.js");
    expect(sw.ok()).toBeTruthy();
    expect(await sw.text()).toContain("reelforge-shell");
  });
});
