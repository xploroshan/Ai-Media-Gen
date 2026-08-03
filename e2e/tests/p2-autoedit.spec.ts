import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { signInWithOtp, uniqueEmail } from "../helpers/auth";
import { uploadFixture, waitForReady } from "../helpers/media";

const FIXTURES = [
  "img1.jpg",
  "img2.jpg",
  "img3.jpg",
  "img4.jpg",
  "vid1.mp4",
  "vid2.mp4",
  "extra1.jpg",
  "extra2.jpg",
  "extra3.jpg",
  "extra4.jpg",
  "extra5.jpg",
  "extra6.jpg",
  "extra7.jpg",
  "extra8.jpg",
  "extra9.jpg",
  "extra10.jpg",
];

type ProjectApi = {
  status: string;
  previewUrl: string | null;
  activeJob: { id: string; type: string } | null;
  lastError: { type: string; message: string | null } | null;
  editSpec: {
    durationSec: number;
    tracks: { type: string; clips: { assetId: string }[] }[];
  };
};

async function fetchProject(page: Page, id: string): Promise<ProjectApi> {
  const res = await page.request.get(`/api/projects/${id}`);
  expect(res.ok()).toBeTruthy();
  return (await res.json()) as ProjectApi;
}

async function waitForPreview(page: Page, id: string, timeoutMs = 300_000): Promise<ProjectApi> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const project = await fetchProject(page, id);
    expect(project.lastError, `pipeline failed: ${JSON.stringify(project.lastError)}`).toBeNull();
    if (project.previewUrl && !project.activeJob) return project;
    if (Date.now() > deadline) throw new Error("preview render did not finish in time");
    await page.waitForTimeout(2500);
  }
}

function videoAssets(project: ProjectApi): string[] {
  const track = project.editSpec.tracks.find((t) => t.type === "video");
  return track ? track.clips.map((c) => c.assetId) : [];
}

function ffprobeJson(filePath: string): {
  format: { duration: string };
  streams: { codec_type: string; width?: number; height?: number }[];
} {
  const out = execFileSync("ffprobe", [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    filePath,
  ]);
  return JSON.parse(out.toString());
}

test.describe("P2 — auto-edit + render", () => {
  test("event → 20s reel: player plays, ffprobe verifies, shuffle differs ≥40%", async ({
    page,
  }) => {
    test.setTimeout(720_000);
    const email = uniqueEmail("p2-reel");
    await signInWithOtp(page, email);

    // setup: upload + analyze fixtures (API-driven; UI covered in P1)
    const assetIds: string[] = [];
    for (const fixture of FIXTURES) assetIds.push(await uploadFixture(page, fixture));
    await waitForReady(page, assetIds);

    // wizard: event → vibe → preset → create
    await page.goto("/create");
    await expect(page.getByTestId("wizard-event")).toBeVisible({ timeout: 60_000 });
    await page.getByTestId("wizard-event").click();
    await page.getByTestId("vibe-travel-cinematic").click();
    await page.getByTestId("preset-reel").click();
    await page.getByLabel("Target length in seconds").fill("20");
    await page.getByTestId("create-reel").click();

    await page.waitForURL("**/projects/**");
    const projectId = page.url().split("/projects/")[1]!.split(/[/?#]/)[0]!;

    // preview render completes (NFR §13: 20s @540p ≤120s — generous bound here)
    const project = await waitForPreview(page, projectId);
    expect(project.editSpec.durationSec).toBe(20);

    // player plays — headless test Chromium ships without H.264/AAC decoders
    // (open-source codec build), so real playback is asserted only when the
    // browser can decode it; the file itself is always ffprobe-verified below.
    await page.reload();
    const video = page.getByTestId("project-video");
    await expect(video).toBeVisible({ timeout: 30_000 });
    const h264Supported = await page.evaluate(
      () => document.createElement("video").canPlayType('video/mp4; codecs="avc1.42E01E"') !== "",
    );
    if (h264Supported) {
      await video.evaluate((el) => {
        const v = el as HTMLVideoElement;
        v.muted = true; // autoplay policy in headless
        return v.play();
      });
      await page.waitForTimeout(1200);
      const playback = await video.evaluate((el) => {
        const v = el as HTMLVideoElement;
        return { currentTime: v.currentTime, paused: v.paused };
      });
      expect(playback.paused).toBe(false);
      expect(playback.currentTime).toBeGreaterThan(0);
    } else {
      // codec-less browser: assert the player is wired to the rendered file
      const src = await video.getAttribute("src");
      expect(src).toBeTruthy();
      const head = await page.request.get(src!);
      expect(head.ok()).toBeTruthy();
      expect(Number(head.headers()["content-length"] ?? 0)).toBeGreaterThan(50_000);
    }

    // ffprobe: duration (20s timeline + 1.5s watermark outro), WxH, v+a streams
    const dl = await page.request.get(project.previewUrl!);
    expect(dl.ok()).toBeTruthy();
    const tmp = mkdtempSync(path.join(tmpdir(), "rf-e2e-"));
    const localPath = path.join(tmp, "preview.mp4");
    writeFileSync(localPath, Buffer.from(await dl.body()));
    const probe = ffprobeJson(localPath);
    expect(Number(probe.format.duration)).toBeGreaterThan(20.9);
    expect(Number(probe.format.duration)).toBeLessThan(22.1);
    const videoStream = probe.streams.find((s) => s.codec_type === "video");
    const audioStream = probe.streams.find((s) => s.codec_type === "audio");
    expect(videoStream?.width).toBe(540);
    expect(videoStream?.height).toBe(960);
    expect(audioStream).toBeTruthy();

    // beat-sync sanity from the spec itself: interior cuts land on beats (±80 ms)
    const clips = project.editSpec.tracks.find((t) => t.type === "video")!.clips as unknown as {
      timelineStart: number;
      duration: number;
    }[];
    const meta = (project.editSpec as unknown as { meta: { beatTimes: number[] } }).meta;
    for (const clip of clips.slice(0, -1)) {
      const cut = clip.timelineStart + clip.duration;
      const nearest = Math.min(...meta.beatTimes.map((b) => Math.abs(b - cut)));
      expect(nearest).toBeLessThanOrEqual(0.081);
    }

    // shuffle ⇒ ≥40% different assets
    const priorAssets = videoAssets(project);
    await page.goto(`/projects/${projectId}`);
    await page.getByTestId("shuffle-button").click();
    await expect(page.getByTestId("render-spinner")).toBeVisible({ timeout: 20_000 });
    const shuffled = await waitForPreview(page, projectId);
    const newAssets = videoAssets(shuffled);
    const prior = new Set(priorAssets);
    const differing = newAssets.filter((a) => !prior.has(a)).length;
    expect(differing / newAssets.length).toBeGreaterThanOrEqual(0.4);
  });
});
