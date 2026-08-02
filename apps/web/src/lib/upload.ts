"use client";

import type { MediaKind } from "@reelforge/shared";

export function kindFromFile(file: File): MediaKind {
  if (file.type.startsWith("video/")) return "video";
  if (file.type.startsWith("audio/")) return "audio";
  return "image";
}

type PresignResponse = {
  assetId: string;
  uploadUrl?: string;
  multipart?: { uploadId: string; partSize: number; partUrls: string[] };
};

/** Presign → PUT (single or multipart) → complete. Returns assetId. */
export async function uploadFile(file: File): Promise<string> {
  const presignRes = await fetch("/api/media/presign-upload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      filename: file.name,
      bytes: file.size,
      kind: kindFromFile(file),
      contentType: file.type || undefined,
    }),
  });
  if (!presignRes.ok) throw new Error(`presign failed (${presignRes.status})`);
  const presign = (await presignRes.json()) as PresignResponse;

  let completeBody: object = {};
  if (presign.multipart) {
    const { uploadId, partSize, partUrls } = presign.multipart;
    const parts: { PartNumber: number; ETag: string }[] = [];
    for (let i = 0; i < partUrls.length; i++) {
      const blob = file.slice(i * partSize, Math.min(file.size, (i + 1) * partSize));
      const res = await fetch(partUrls[i]!, { method: "PUT", body: blob });
      if (!res.ok) throw new Error(`part ${i + 1} upload failed (${res.status})`);
      parts.push({ PartNumber: i + 1, ETag: res.headers.get("ETag") ?? "" });
    }
    completeBody = { multipart: { uploadId, parts } };
  } else if (presign.uploadUrl) {
    const res = await fetch(presign.uploadUrl, {
      method: "PUT",
      body: file,
      headers: file.type ? { "Content-Type": file.type } : undefined,
    });
    if (!res.ok) throw new Error(`upload failed (${res.status})`);
  } else {
    throw new Error("presign response missing uploadUrl/multipart");
  }

  const completeRes = await fetch(`/api/media/${presign.assetId}/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(completeBody),
  });
  if (!completeRes.ok) throw new Error(`complete failed (${completeRes.status})`);
  return presign.assetId;
}
