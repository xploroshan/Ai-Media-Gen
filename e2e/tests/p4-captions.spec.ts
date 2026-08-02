import { expect, test, type Page } from "@playwright/test";
import { signInWithOtp, uniqueEmail } from "../helpers/auth";
import { uploadFixture, waitForReady } from "../helpers/media";

const MEDIA = ["speech.mp4", "img1.jpg", "img3.jpg", "extra1.jpg"];

type ProjectApi = {
  previewUrl: string | null;
  activeJob: { id: string } | null;
  lastError: { type: string; message: string | null } | null;
  editSpec: {
    captions: { enabled: boolean; words: { w: string; s: number; e: number }[] };
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

test.describe("P4 — captions + audio", () => {
  test("speech fixture → words editable → burned render completes", async ({ page }) => {
    test.setTimeout(720_000);
    const email = uniqueEmail("p4-captions");
    await signInWithOtp(page, email);

    const assetIds: string[] = [];
    for (const fixture of MEDIA) assetIds.push(await uploadFixture(page, fixture));
    await waitForReady(page, assetIds);

    const createRes = await page.request.post("/api/projects", {
      data: { assetIds, vibeId: "travel-cinematic", presetId: "reel", targetSec: 10 },
    });
    expect(createRes.ok()).toBeTruthy();
    const { projectId } = (await createRes.json()) as { projectId: string };
    await waitIdle(page, projectId);

    await page.goto(`/editor/${projectId}`);
    await expect(page.getByTestId("captions-panel")).toBeVisible({ timeout: 30_000 });

    // generate captions from the speech video (first transcription loads whisper — allow time)
    const speechAssetId = assetIds[0]!;
    await page.getByTestId("caption-source").selectOption(speechAssetId);
    await page.getByTestId("generate-captions").click();
    await expect(page.getByTestId("caption-words")).toBeVisible({ timeout: 300_000 });

    const wordInputs = page.getByTestId("caption-words").locator("input");
    const wordCount = await wordInputs.count();
    expect(wordCount).toBeGreaterThan(0);

    // words are editable inline
    await wordInputs.first().fill("Bonjour");
    await expect(page.getByTestId("save-state")).toHaveText("Saved", { timeout: 15_000 });
    const edited = await getProject(page, projectId);
    expect(edited.editSpec.captions.enabled).toBe(true);
    expect(edited.editSpec.captions.words[0]!.w).toBe("Bonjour");

    // timing nudge shifts the word
    const before = edited.editSpec.captions.words[0]!;
    await page.getByRole("button", { name: "Nudge word 1 later" }).click();
    await expect(page.getByTestId("save-state")).toHaveText("Saved", { timeout: 15_000 });
    const nudged = await getProject(page, projectId);
    expect(nudged.editSpec.captions.words[0]!.s).toBeCloseTo(before.s + 0.1, 2);

    // burned render completes with captions enabled
    await page.getByTestId("preview-render").click();
    const rendered = await waitIdle(page, projectId);
    expect(rendered.previewUrl).toBeTruthy();
    expect(rendered.editSpec.captions.enabled).toBe(true);
    const dl = await page.request.get(rendered.previewUrl!);
    expect(dl.ok()).toBeTruthy();
  });
});
