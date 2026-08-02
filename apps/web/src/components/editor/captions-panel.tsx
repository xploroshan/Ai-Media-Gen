"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useEditorStore } from "@/lib/editor/store";
import type { AssetMap } from "./preview-canvas";

const CAPTION_STYLES = ["karaoke-yellow", "karaoke-clean"];

type Transcript = { lang: string; words: { w: string; s: number; e: number }[] };

/** Caption editor (SPEC §7): generate via transcribe job, inline word edit + timing nudge. */
export function CaptionsPanel({ assets }: { assets: AssetMap }) {
  const spec = useEditorStore((s) => s.spec);
  const setCaptions = useEditorStore((s) => s.setCaptions);
  const updateCaptionWord = useEditorStore((s) => s.updateCaptionWord);
  const nudgeCaptionWord = useEditorStore((s) => s.nudgeCaptionWord);

  const [source, setSource] = useState("");
  const [state, setState] = useState<"idle" | "working" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  if (!spec) return null;
  const captions = spec.captions;
  const speechSources = Object.entries(assets).filter(
    ([, a]) => a.kind === "video" || a.kind === "audio",
  );

  async function generate() {
    if (!source) return;
    setState("working");
    setError(null);
    try {
      const res = await fetch(`/api/media/${source}/transcribe`, { method: "POST" });
      if (!res.ok) throw new Error(`transcribe request failed (${res.status})`);
      const { jobId } = (await res.json()) as { jobId: string };
      const deadline = Date.now() + 240_000;
      for (;;) {
        const jobRes = await fetch(`/api/jobs/${jobId}`);
        const job = (await jobRes.json()) as { status: string; error?: string };
        if (job.status === "done") break;
        if (job.status === "failed") throw new Error(job.error ?? "transcription failed");
        if (Date.now() > deadline) throw new Error("transcription timed out");
        await new Promise((r) => setTimeout(r, 2000));
      }
      const assetRes = await fetch(`/api/media/${source}`);
      const asset = (await assetRes.json()) as { analysis?: { transcript?: Transcript } };
      const transcript = asset.analysis?.transcript;
      if (!transcript?.words?.length) throw new Error("no speech detected in this clip");
      setCaptions({
        enabled: true,
        lang: transcript.lang === "hi" ? "hi" : "en",
        words: transcript.words,
      });
      setState("idle");
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed");
      setState("error");
    }
  }

  return (
    <section
      className="rounded-lg border border-border bg-surface p-4 text-sm"
      aria-label="Captions"
      data-testid="captions-panel"
    >
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <h3 className="font-medium">Captions</h3>
        <label className="flex items-center gap-1.5 text-muted">
          <input
            type="checkbox"
            checked={captions.enabled}
            data-testid="captions-enabled"
            onChange={(e) => setCaptions({ enabled: e.target.checked })}
          />
          burn in
        </label>
        <select
          className="h-8 rounded-lg border border-border bg-surface px-2 text-xs"
          value={captions.styleId}
          onChange={(e) => setCaptions({ styleId: e.target.value })}
          aria-label="Caption style"
        >
          {CAPTION_STYLES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <div className="ml-auto flex items-center gap-2">
          <select
            className="h-8 rounded-lg border border-border bg-surface px-2 text-xs"
            value={source}
            onChange={(e) => setSource(e.target.value)}
            aria-label="Speech source"
            data-testid="caption-source"
          >
            <option value="">Pick a clip with speech…</option>
            {speechSources.map(([id, asset]) => (
              <option key={id} value={id}>
                {asset.kind} · {id.slice(-6)}
              </option>
            ))}
          </select>
          <Button
            size="sm"
            variant="secondary"
            disabled={!source || state === "working"}
            onClick={generate}
            data-testid="generate-captions"
          >
            {state === "working" ? "Transcribing…" : "Generate captions"}
          </Button>
        </div>
      </div>

      {error ? (
        <p role="alert" className="mb-2 text-xs text-danger">
          {error}
        </p>
      ) : null}

      {captions.words.length ? (
        <ul className="max-h-44 space-y-1 overflow-y-auto" data-testid="caption-words">
          {captions.words.map((word, i) => (
            <li key={i} className="flex items-center gap-2">
              <Input
                className="h-7 flex-1 text-xs"
                value={word.w}
                data-testid={`caption-word-${i}`}
                onChange={(e) => updateCaptionWord(i, { w: e.target.value })}
              />
              <span className="w-24 shrink-0 text-right text-[10px] tabular-nums text-muted">
                {word.s.toFixed(2)}–{word.e.toFixed(2)}s
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-1.5 text-[10px]"
                aria-label={`Nudge word ${i + 1} earlier`}
                onClick={() => nudgeCaptionWord(i, -0.1)}
              >
                −0.1s
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-1.5 text-[10px]"
                aria-label={`Nudge word ${i + 1} later`}
                onClick={() => nudgeCaptionWord(i, 0.1)}
              >
                +0.1s
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted">
          No caption words yet — generate them from a clip with speech, or they stay off.
        </p>
      )}
    </section>
  );
}
