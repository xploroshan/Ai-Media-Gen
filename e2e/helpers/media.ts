import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, type Page } from "@playwright/test";

export const FIXTURES_DIR = path.join(__dirname, "..", "fixtures");

const MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".mp4": "video/mp4",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
};

function kindOf(file: string): "image" | "video" | "audio" {
  const ext = path.extname(file);
  if (ext === ".mp4") return "video";
  if (ext === ".mp3" || ext === ".wav") return "audio";
  return "image";
}

/** API-driven upload (presign → PUT → complete). Faster than UI for setup steps. */
export async function uploadFixture(page: Page, filename: string): Promise<string> {
  const filePath = path.join(FIXTURES_DIR, filename);
  const buffer = readFileSync(filePath);
  const contentType = MIME[path.extname(filename)] ?? "application/octet-stream";

  const presignRes = await page.request.post("/api/media/presign-upload", {
    data: { filename, bytes: buffer.length, kind: kindOf(filename), contentType },
  });
  expect(presignRes.ok()).toBeTruthy();
  const presign = (await presignRes.json()) as { assetId: string; uploadUrl: string };

  const putRes = await page.request.fetch(presign.uploadUrl, {
    method: "PUT",
    data: buffer,
    headers: { "Content-Type": contentType },
  });
  expect(putRes.ok()).toBeTruthy();

  const completeRes = await page.request.post(`/api/media/${presign.assetId}/complete`, {
    data: {},
  });
  expect(completeRes.ok()).toBeTruthy();
  return presign.assetId;
}

/** Wait until every given asset is `ready` (or fail on `failed`). */
export async function waitForReady(
  page: Page,
  assetIds: string[],
  timeoutMs = 240_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await page.request.get("/api/media");
    const { items } = (await res.json()) as { items: { id: string; status: string }[] };
    const mine = items.filter((i) => assetIds.includes(i.id));
    const failed = mine.filter((i) => i.status === "failed");
    expect(failed, `assets failed analysis: ${failed.map((f) => f.id).join(",")}`).toHaveLength(0);
    if (mine.length === assetIds.length && mine.every((i) => i.status === "ready")) return;
    if (Date.now() > deadline) {
      throw new Error(
        `assets not ready in ${timeoutMs}ms: ${mine.map((m) => `${m.id}=${m.status}`).join(",")}`,
      );
    }
    await page.waitForTimeout(2000);
  }
}
