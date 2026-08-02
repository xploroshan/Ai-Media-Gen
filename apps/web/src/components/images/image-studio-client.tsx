"use client";

import { useEffect, useRef, useState } from "react";
import useSWR from "swr";
import { Button } from "@/components/ui/button";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

type MediaItem = {
  id: string;
  kind: string;
  status: string;
  filename: string;
  thumbUrl: string | null;
};

type AssetDetail = {
  id: string;
  filename: string;
  width: number | null;
  height: number | null;
  originalUrl: string;
};

const OPS = [
  { op: "enhance", label: "Enhance", blurb: "Auto contrast, color balance & pop" },
  { op: "bg_remove", label: "Remove background", blurb: "Cutout with transparent background" },
  { op: "erase", label: "Erase object", blurb: "Paint over anything to remove it" },
  { op: "upscale", label: "Upscale ×2", blurb: "Sharper, larger image (may be slow)" },
] as const;

export function ImageStudioClient() {
  const { data: media, mutate } = useSWR<{ items: MediaItem[] }>("/api/media?kind=image", fetcher, {
    refreshInterval: (latest) => (latest?.items?.some((i) => i.status === "analyzing") ? 2500 : 0),
  });
  const [selected, setSelected] = useState<string | null>(null);
  const [busyOp, setBusyOp] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [erasing, setErasing] = useState(false);

  const images = (media?.items ?? []).filter((m) => m.kind === "image");
  const readyImages = images.filter((m) => m.status === "ready" && m.thumbUrl);

  async function runOp(op: string, maskDataUrl?: string) {
    if (!selected) return;
    setBusyOp(op);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch(`/api/images/${selected}/op`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ op, params: maskDataUrl ? { maskDataUrl } : {} }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        throw new Error(body?.error?.message ?? `failed (${res.status})`);
      }
      const { jobId } = (await res.json()) as { jobId: string };
      const deadline = Date.now() + 300_000;
      for (;;) {
        const jobRes = await fetch(`/api/jobs/${jobId}`);
        const job = (await jobRes.json()) as { status: string; error?: string };
        if (job.status === "done") break;
        if (job.status === "failed") throw new Error(job.error ?? "operation failed");
        if (Date.now() > deadline) throw new Error("operation timed out");
        await new Promise((r) => setTimeout(r, 2500));
      }
      setMessage("Done — the result was added to your library as a new image.");
      setErasing(false);
      void mutate();
    } catch (err) {
      setError(err instanceof Error ? err.message : "operation failed");
    } finally {
      setBusyOp(null);
    }
  }

  return (
    <div className="max-w-4xl">
      {readyImages.length === 0 ? (
        <p className="text-sm text-muted">
          No ready images yet — upload photos in the Library first.
        </p>
      ) : (
        <>
          <h2 className="mb-2 text-sm font-medium text-muted">1 · Pick an image</h2>
          <div className="mb-6 grid grid-cols-4 gap-2 sm:grid-cols-6 md:grid-cols-8">
            {images.map((img) => (
              <button
                key={img.id}
                onClick={() => {
                  setSelected(img.id);
                  setErasing(false);
                  setMessage(null);
                }}
                aria-pressed={selected === img.id}
                data-testid={`pick-image-${img.filename}`}
                className={`relative aspect-square overflow-hidden rounded-md border-2 ${
                  selected === img.id ? "border-primary" : "border-transparent"
                }`}
                title={img.filename}
              >
                {img.thumbUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={img.thumbUrl}
                    alt={img.filename}
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <span className="flex h-full items-center justify-center text-[10px] text-muted">
                    {img.status}…
                  </span>
                )}
              </button>
            ))}
          </div>

          {selected ? (
            <>
              <h2 className="mb-2 text-sm font-medium text-muted">2 · Choose a fix</h2>
              <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {OPS.map(({ op, label, blurb }) => (
                  <button
                    key={op}
                    data-testid={`op-${op}`}
                    disabled={busyOp !== null}
                    onClick={() => (op === "erase" ? setErasing(true) : runOp(op))}
                    className="rounded-lg border border-border bg-surface p-3 text-left transition-colors hover:border-primary disabled:opacity-50"
                  >
                    <p className="text-sm font-medium">{busyOp === op ? "Working…" : label}</p>
                    <p className="text-xs text-muted">{blurb}</p>
                  </button>
                ))}
              </div>

              {erasing ? (
                <EraseCanvas
                  assetId={selected}
                  busy={busyOp !== null}
                  onSubmit={(maskDataUrl) => runOp("erase", maskDataUrl)}
                  onCancel={() => setErasing(false)}
                />
              ) : null}
            </>
          ) : null}

          {message ? (
            <p className="text-sm text-success" data-testid="op-success">
              {message}
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

/** Mask painting canvas: white strokes on black = area to erase (SPEC §6.7). */
function EraseCanvas({
  assetId,
  busy,
  onSubmit,
  onCancel,
}: {
  assetId: string;
  busy: boolean;
  onSubmit: (maskDataUrl: string) => void;
  onCancel: () => void;
}) {
  const { data: asset } = useSWR<AssetDetail>(`/api/media/${assetId}`, fetcher);
  const imgRef = useRef<HTMLImageElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const [hasStrokes, setHasStrokes] = useState(false);
  const [brush, setBrush] = useState(28);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas) {
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "black";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      setHasStrokes(false);
    }
  }, [asset?.id]);

  if (!asset) return <div className="h-64 animate-pulse rounded-lg bg-surface-2" />;
  const w = asset.width ?? 800;
  const h = asset.height ?? 600;

  function paint(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return;
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * canvas.width;
    const y = ((e.clientY - rect.top) / rect.height) * canvas.height;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "white";
    ctx.beginPath();
    ctx.arc(x, y, brush * (canvas.width / rect.width), 0, Math.PI * 2);
    ctx.fill();
    setHasStrokes(true);
  }

  return (
    <div className="mb-4 rounded-lg border border-border bg-surface p-4" data-testid="erase-canvas">
      <p className="mb-2 text-sm text-muted">Paint over what you want to remove, then apply.</p>
      <div className="relative inline-block max-w-full">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          ref={imgRef}
          src={asset.originalUrl}
          alt={asset.filename}
          className="max-h-96 w-auto max-w-full rounded"
        />
        <canvas
          ref={canvasRef}
          width={w}
          height={h}
          className="absolute inset-0 h-full w-full cursor-crosshair opacity-50"
          onPointerDown={(e) => {
            drawing.current = true;
            e.currentTarget.setPointerCapture(e.pointerId);
            paint(e);
          }}
          onPointerMove={paint}
          onPointerUp={(e) => {
            drawing.current = false;
            e.currentTarget.releasePointerCapture(e.pointerId);
          }}
        />
      </div>
      <div className="mt-3 flex items-center gap-3">
        <label className="text-xs text-muted">
          Brush {brush}px
          <input
            type="range"
            min={8}
            max={80}
            value={brush}
            onChange={(e) => setBrush(Number(e.target.value))}
            className="ml-2 align-middle"
          />
        </label>
        <Button
          size="sm"
          disabled={!hasStrokes || busy}
          data-testid="apply-erase"
          onClick={() => onSubmit(canvasRef.current!.toDataURL("image/png"))}
        >
          {busy ? "Erasing…" : "Apply erase"}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
