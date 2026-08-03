"use client";

import { useState } from "react";
import useSWR from "swr";
import { Button } from "@/components/ui/button";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

type Preset = { id: string; name: string; aspect: string; maxSec: number };

type ExportState = {
  id: string;
  status: string;
  downloadUrl: string | null;
  watermark: boolean;
  containsSynthetic: boolean;
  caption: string;
};

export function ExportDialog({
  projectId,
  aspect,
  onClose,
}: {
  projectId: string;
  aspect: string;
  onClose: () => void;
}) {
  const { data: meta } = useSWR<{ presets: Preset[] }>("/api/meta", fetcher);
  const { data: credits } = useSWR<{ plan: string }>("/api/credits", fetcher);
  const [presetId, setPresetId] = useState("reel");
  const [resolution, setResolution] = useState<"720p" | "1080p">("720p");
  const [exportState, setExportState] = useState<ExportState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const plan = credits?.plan ?? "free";
  const presets = (meta?.presets ?? []).filter((p) => p.aspect === aspect);

  async function startExport() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/export`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ presetId, resolution }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        throw new Error(body?.error?.message ?? `Export failed (${res.status})`);
      }
      const { exportId } = (await res.json()) as { exportId: string };
      const deadline = Date.now() + 600_000;
      let misses = 0; // a transient poll blip must not kill a 10-minute render
      for (;;) {
        let state: ExportState | null = null;
        try {
          const stateRes = await fetch(`/api/exports/${exportId}`);
          if (!stateRes.ok) throw new Error(`poll ${stateRes.status}`);
          state = (await stateRes.json()) as ExportState;
          misses = 0;
        } catch {
          misses += 1;
          if (misses >= 5) throw new Error("Lost connection while exporting.");
        }
        if (state?.status === "done") {
          setExportState(state);
          break;
        }
        if (state?.status === "failed") throw new Error("Render failed — try again.");
        if (Date.now() > deadline) throw new Error("Export timed out.");
        await new Promise((r) => setTimeout(r, 3000));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "export failed");
    } finally {
      setBusy(false);
    }
  }

  async function share() {
    if (!exportState?.downloadUrl) return;
    try {
      const blob = await (await fetch(exportState.downloadUrl)).blob();
      const file = new File([blob], "reel.mp4", { type: "video/mp4" });
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], text: exportState.caption });
      } else {
        window.open(exportState.downloadUrl, "_blank");
      }
    } catch {
      /* user cancelled */
    }
  }

  return (
    <div
      role="dialog"
      aria-label="Export"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      data-testid="export-dialog"
    >
      <div className="w-full max-w-md rounded-xl border border-border bg-surface p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Export</h2>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close export">
            ✕
          </Button>
        </div>

        {!exportState ? (
          <>
            <label className="mb-3 block text-sm">
              <span className="text-muted">Platform preset</span>
              <select
                className="mt-1 h-9 w-full rounded-lg border border-border bg-surface-2 px-2"
                value={presetId}
                onChange={(e) => setPresetId(e.target.value)}
                data-testid="export-preset"
              >
                {presets.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} (max {p.maxSec}s)
                  </option>
                ))}
              </select>
            </label>
            <div className="mb-3 flex gap-2 text-sm" role="radiogroup" aria-label="Resolution">
              {(["720p", "1080p"] as const).map((res) => {
                const locked = res === "1080p" && plan === "free";
                return (
                  <button
                    key={res}
                    role="radio"
                    aria-checked={resolution === res}
                    disabled={locked}
                    data-testid={`res-${res}`}
                    onClick={() => setResolution(res)}
                    className={`rounded-lg border px-3 py-1.5 ${
                      resolution === res ? "border-primary bg-surface-2" : "border-border"
                    } ${locked ? "opacity-50" : ""}`}
                  >
                    {res}
                    {locked ? " 🔒 Creator" : ""}
                  </button>
                );
              })}
            </div>
            {plan === "free" ? (
              <p className="mb-3 text-xs text-muted">
                Free plan exports include a small ReelForge watermark.
              </p>
            ) : null}
            {error ? (
              <p role="alert" className="mb-3 text-sm text-danger">
                {error}
              </p>
            ) : null}
            <Button
              className="w-full"
              onClick={startExport}
              disabled={busy}
              data-testid="start-export"
            >
              {busy ? "Rendering final video…" : "Export video"}
            </Button>
          </>
        ) : (
          <>
            {exportState.containsSynthetic ? (
              <p
                className="mb-3 rounded-lg bg-surface-2 p-2 text-xs text-muted"
                data-testid="synthetic-disclosure"
              >
                Heads up: this video contains AI-generated content. Many platforms ask you to
                disclose that when posting.
              </p>
            ) : null}
            <a href={exportState.downloadUrl!} download="reel.mp4">
              <Button className="mb-2 w-full" data-testid="export-download">
                Download video
              </Button>
            </a>
            <Button variant="secondary" className="mb-3 w-full" onClick={share}>
              Share…
            </Button>
            <label className="block text-sm">
              <span className="text-muted">Caption</span>
              <textarea
                readOnly
                className="mt-1 h-28 w-full rounded-lg border border-border bg-surface-2 p-2 text-xs"
                value={exportState.caption}
                data-testid="export-caption"
              />
            </label>
            <Button
              variant="ghost"
              size="sm"
              className="mt-1"
              onClick={async () => {
                await navigator.clipboard.writeText(exportState.caption);
                setCopied(true);
              }}
            >
              {copied ? "Copied!" : "Copy caption"}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
