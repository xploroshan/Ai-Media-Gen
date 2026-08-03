"use client";

import { useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import { Button } from "@/components/ui/button";
import { ExportDialog } from "./export-dialog";

type ProjectData = {
  id: string;
  title: string;
  aspect: string;
  status: string;
  previewUrl: string | null;
  activeJob: { id: string; type: string; status: string; progress: number | null } | null;
  lastError: { type: string; message: string | null } | null;
};

const fetcher = (url: string) => fetch(url).then((r) => r.json());

const STEERING_CHIPS = [
  { key: "faster", label: "Faster pace", steering: { pace: "faster" } },
  { key: "slower", label: "Slower pace", steering: { pace: "slower" } },
  { key: "fewer", label: "Fewer clips", steering: { fewerClips: true } },
  { key: "people", label: "More people", steering: { peopleBias: 1 } },
  { key: "scenery", label: "More scenery", steering: { peopleBias: -1 } },
] as const;

export function ProjectPlayer({ projectId }: { projectId: string }) {
  const [chips, setChips] = useState<Set<string>>(new Set());
  const [exporting, setExporting] = useState(false);
  const { data, mutate } = useSWR<ProjectData>(`/api/projects/${projectId}`, fetcher, {
    refreshInterval: (latest) => (latest?.activeJob ? 2000 : 0),
  });

  async function shuffle() {
    const steering = [...chips].reduce<Record<string, unknown>>((acc, key) => {
      const chip = STEERING_CHIPS.find((c) => c.key === key);
      return chip ? { ...acc, ...chip.steering } : acc;
    }, {});
    await fetch(`/api/projects/${projectId}/shuffle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ steering: Object.keys(steering).length ? steering : undefined }),
    });
    void mutate();
  }

  if (!data) {
    return (
      <div className="mx-auto aspect-[9/16] max-h-[70vh] animate-pulse rounded-xl bg-surface-2" />
    );
  }

  const busy = Boolean(data.activeJob);
  const aspectClass =
    data.aspect === "16:9"
      ? "aspect-video"
      : data.aspect === "1:1"
        ? "aspect-square"
        : "aspect-[9/16]";

  return (
    <div className="mx-auto max-w-lg">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h1 className="truncate text-xl font-semibold">{data.title}</h1>
        <Link
          href={`/editor/${data.id}`}
          className="text-sm text-primary underline-offset-4 hover:underline"
        >
          Open editor
        </Link>
      </div>

      <div
        className={`relative mx-auto ${aspectClass} max-h-[70vh] overflow-hidden rounded-xl border border-border bg-black`}
      >
        {data.previewUrl && !busy ? (
          <video
            key={data.previewUrl}
            src={data.previewUrl}
            controls
            playsInline
            data-testid="project-video"
            className="h-full w-full object-contain"
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
            {data.lastError ? (
              <>
                <p role="alert" className="text-sm text-danger">
                  {data.lastError.type} failed: {data.lastError.message ?? "unknown error"}
                </p>
                <Button variant="secondary" size="sm" onClick={shuffle}>
                  Try again
                </Button>
              </>
            ) : (
              <>
                <div
                  className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent"
                  role="status"
                  aria-label="Rendering"
                  data-testid="render-spinner"
                />
                <p className="text-sm text-muted">
                  {data.activeJob?.type === "autoedit_generate"
                    ? "Planning your edit…"
                    : `Rendering preview… ${data.activeJob?.progress != null ? `${data.activeJob.progress}%` : ""}`}
                </p>
              </>
            )}
          </div>
        )}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2" aria-label="Steering">
        {STEERING_CHIPS.map((chip) => (
          <button
            key={chip.key}
            aria-pressed={chips.has(chip.key)}
            onClick={() =>
              setChips((prev) => {
                const next = new Set(prev);
                if (next.has(chip.key)) {
                  next.delete(chip.key);
                } else {
                  next.add(chip.key);
                }
                return next;
              })
            }
            className={`rounded-full border px-3 py-1 text-xs ${
              chips.has(chip.key) ? "border-primary bg-surface-2" : "border-border text-muted"
            }`}
          >
            {chip.label}
          </button>
        ))}
      </div>

      <div className="mt-4 flex gap-3">
        <Button onClick={shuffle} disabled={busy} data-testid="shuffle-button">
          Shuffle
        </Button>
        {data.previewUrl ? (
          <a href={data.previewUrl} download={`${data.title}.mp4`}>
            <Button variant="secondary" data-testid="download-button">
              Download preview
            </Button>
          </a>
        ) : null}
        <Button
          variant="secondary"
          disabled={busy || !data.previewUrl}
          onClick={() => setExporting(true)}
          data-testid="open-export"
        >
          Export
        </Button>
      </div>

      {exporting ? (
        <ExportDialog
          projectId={projectId}
          aspect={data.aspect}
          onClose={() => setExporting(false)}
        />
      ) : null}
    </div>
  );
}
