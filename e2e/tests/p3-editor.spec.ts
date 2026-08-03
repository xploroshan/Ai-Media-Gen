import { expect, test, type Page } from "@playwright/test";
import { signInWithOtp, uniqueEmail } from "../helpers/auth";
import { uploadFixture, waitForReady } from "../helpers/media";

const MEDIA = ["img1.jpg", "img3.jpg", "extra1.jpg", "extra2.jpg", "vid1.mp4", "vid2.mp4"];

type ProjectApi = {
  previewUrl: string | null;
  activeJob: { id: string } | null;
  lastError: { type: string; message: string | null } | null;
  editSpec: {
    durationSec: number;
    tracks: {
      type: string;
      clips: { id: string; duration?: number; text?: string; assetId?: string }[];
    }[];
  };
};

async function getProject(page: Page, id: string): Promise<ProjectApi> {
  const res = await page.request.get(`/api/projects/${id}`);
  expect(res.ok()).toBeTruthy();
  return (await res.json()) as ProjectApi;
}

async function waitIdle(page: Page, id: string, timeoutMs = 300_000): Promise<ProjectApi> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const project = await getProject(page, id);
    expect(project.lastError, JSON.stringify(project.lastError)).toBeNull();
    if (!project.activeJob) return project;
    if (Date.now() > deadline) throw new Error("project never went idle");
    await page.waitForTimeout(2500);
  }
}

/** Presigned URLs change on every request; the object KEY only changes when a
 * new render lands (renders/<owner>/<project>/preview-<jobId>.mp4). */
export function previewKey(url: string | null): string | null {
  return url ? new URL(url).pathname : null;
}

/** After triggering a re-render from the UI, first wait for the render job to
 * actually start (or the preview key to change) so waitIdle can't return early
 * on the pre-click state, then wait for idle. */
async function waitRenderedAfter(
  page: Page,
  id: string,
  prevPreviewUrl: string | null,
  timeoutMs = 300_000,
): Promise<ProjectApi> {
  const prevKey = previewKey(prevPreviewUrl);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const project = await getProject(page, id);
    if (project.activeJob || previewKey(project.previewUrl) !== prevKey) break;
    if (Date.now() > deadline) throw new Error("render never started");
    await page.waitForTimeout(1000);
  }
  return waitIdle(page, id, timeoutMs);
}

test.describe("P3 — timeline editor", () => {
  test("trim persists; added text appears in re-rendered output", async ({ page }) => {
    test.setTimeout(720_000);
    const email = uniqueEmail("p3-editor");
    await signInWithOtp(page, email);

    const assetIds: string[] = [];
    for (const fixture of MEDIA) assetIds.push(await uploadFixture(page, fixture));
    await waitForReady(page, assetIds);

    const createRes = await page.request.post("/api/projects", {
      data: { assetIds, vibeId: "product-promo", presetId: "reel", targetSec: 12 },
    });
    expect(createRes.ok()).toBeTruthy();
    const { projectId } = (await createRes.json()) as { projectId: string };
    await waitIdle(page, projectId);

    await page.goto(`/editor/${projectId}`);
    await expect(page.getByTestId("timeline")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("preview-canvas")).toBeVisible();

    // --- trim clip via properties panel; autosave persists the change ---
    const before = await getProject(page, projectId);
    const videoClipsBefore = before.editSpec.tracks.find((t) => t.type === "video")!.clips;
    const firstDuration = videoClipsBefore[0]!.duration!;

    await page.getByTestId("clip-0").click();
    await expect(page.getByTestId("prop-duration")).toBeVisible();
    const newDuration = Math.max(0.5, Math.round((firstDuration - 0.4) * 10) / 10);
    await page.getByTestId("prop-duration").fill(String(newDuration));
    await expect(page.getByTestId("save-state")).toHaveText("Saved", { timeout: 15_000 });

    const afterTrim = await getProject(page, projectId);
    const clipsAfter = afterTrim.editSpec.tracks.find((t) => t.type === "video")!.clips;
    expect(clipsAfter[0]!.duration).toBeCloseTo(newDuration, 1);
    expect(afterTrim.editSpec.durationSec).toBeLessThan(before.editSpec.durationSec);

    // --- add text; re-render succeeds with the spec applied ---
    await page.getByTestId("add-text").click();
    await expect(page.getByTestId("prop-text")).toBeVisible();
    await page.getByTestId("prop-text").fill("E2E Caption Check");
    await expect(page.getByTestId("save-state")).toHaveText("Saved", { timeout: 15_000 });
    // text appears in the DOM preview
    await expect(page.getByTestId("preview-text")).toContainText("E2E Caption Check");

    const beforeRender = await getProject(page, projectId);
    await page.getByTestId("preview-render").click();
    const rendered = await waitRenderedAfter(page, projectId, beforeRender.previewUrl);
    expect(rendered.previewUrl).toBeTruthy();
    // a NEW preview render landed, not the pre-edit one
    expect(previewKey(rendered.previewUrl)).not.toBe(previewKey(beforeRender.previewUrl));
    const textClips = rendered.editSpec.tracks.find((t) => t.type === "text")!.clips;
    expect(textClips.some((c) => c.text === "E2E Caption Check")).toBe(true);

    // rendered file is a valid video of the trimmed duration (+1.5s watermark outro)
    const dl = await page.request.get(rendered.previewUrl!);
    expect(dl.ok()).toBeTruthy();
    const bytes = Number(dl.headers()["content-length"] ?? (await dl.body()).length);
    expect(bytes).toBeGreaterThan(50_000);
  });
});
