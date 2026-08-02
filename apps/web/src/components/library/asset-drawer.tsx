"use client";

import useSWR from "swr";
import { Button } from "@/components/ui/button";

type AssetDetail = {
  id: string;
  kind: string;
  status: string;
  filename: string;
  bytes: number;
  width: number | null;
  height: number | null;
  durationSec: number | null;
  fps: number | null;
  takenAt: string | null;
  synthetic: boolean;
  thumbUrl: string | null;
  originalUrl: string;
  proxyUrl: string | null;
  analysis: {
    qualityScore: number | null;
    tags: { label: string; score: number }[] | null;
    facesCount: number | null;
    sceneCuts: number[] | null;
    highlights: { start: number; end: number; score: number }[] | null;
  } | null;
};

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export function AssetDrawer({ assetId, onClose }: { assetId: string; onClose: () => void }) {
  const { data, isLoading } = useSWR<AssetDetail>(`/api/media/${assetId}`, fetcher);

  return (
    <div
      role="dialog"
      aria-label="Asset details"
      className="fixed inset-y-0 right-0 z-40 w-full max-w-sm overflow-y-auto border-l border-border bg-surface p-5 shadow-xl"
      data-testid="asset-drawer"
    >
      <div className="mb-4 flex items-center justify-between">
        <h2 className="truncate text-lg font-semibold">{data?.filename ?? "…"}</h2>
        <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close details">
          ✕
        </Button>
      </div>

      {isLoading || !data ? (
        <div className="h-48 animate-pulse rounded-lg bg-surface-2" />
      ) : (
        <>
          {data.kind === "video" && data.proxyUrl ? (
            <video src={data.proxyUrl} controls className="mb-4 w-full rounded-lg" />
          ) : data.thumbUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={data.thumbUrl} alt={data.filename} className="mb-4 w-full rounded-lg" />
          ) : null}

          <dl className="space-y-1.5 text-sm">
            <Row label="Status" value={data.status} />
            <Row label="Kind" value={data.kind} />
            {data.width && data.height ? (
              <Row label="Dimensions" value={`${data.width}×${data.height}`} />
            ) : null}
            {data.durationSec ? (
              <Row label="Duration" value={`${data.durationSec.toFixed(1)}s`} />
            ) : null}
            {data.takenAt ? (
              <Row label="Taken" value={new Date(data.takenAt).toLocaleString()} />
            ) : null}
            {data.analysis?.qualityScore != null ? (
              <Row
                label="Quality"
                value={`${Math.round(data.analysis.qualityScore * 100)}%`}
                testId="quality-score"
              />
            ) : null}
            {data.analysis?.facesCount != null ? (
              <Row label="Faces" value={String(data.analysis.facesCount)} />
            ) : null}
          </dl>

          {data.analysis?.tags?.length ? (
            <div className="mt-4">
              <h3 className="mb-1.5 text-sm font-medium text-muted">Tags</h3>
              <div className="flex flex-wrap gap-1.5" data-testid="asset-tags">
                {data.analysis.tags.map((tag) => (
                  <span
                    key={tag.label}
                    className="rounded-full bg-surface-2 px-2 py-0.5 text-xs text-foreground"
                  >
                    {tag.label}
                  </span>
                ))}
              </div>
            </div>
          ) : null}

          <div className="mt-6">
            <a href={data.originalUrl} download={data.filename}>
              <Button variant="secondary" className="w-full">
                Download original
              </Button>
            </a>
          </div>
        </>
      )}
    </div>
  );
}

function Row({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-muted">{label}</dt>
      <dd data-testid={testId}>{value}</dd>
    </div>
  );
}
