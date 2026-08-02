"use client";

import useSWR from "swr";
import { TRANSITION_TYPES } from "@reelforge/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useEditorStore } from "@/lib/editor/store";
import type { AssetMap } from "./preview-canvas";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

const TEXT_STYLES = ["title-bold", "title-serif-white", "pop-bold-yellow", "clean-sans-brand"];

/** Right-hand properties panel for the selected clip (SPEC §7). */
export function PropertiesPanel({ assets }: { assets: AssetMap }) {
  const spec = useEditorStore((s) => s.spec);
  const selection = useEditorStore((s) => s.selection);
  const trimClip = useEditorStore((s) => s.trimClip);
  const updateClip = useEditorStore((s) => s.updateClip);
  const updateText = useEditorStore((s) => s.updateText);
  const deleteSelected = useEditorStore((s) => s.deleteSelected);
  const replaceMusic = useEditorStore((s) => s.replaceMusic);

  const { data: music } = useSWR<{
    tracks: { id: string; title: string; source: string }[];
    uploads: { id: string; title: string; source: string }[];
  }>("/api/music", fetcher);

  if (!spec) return null;

  const videoTrack = spec.tracks.find((t) => t.type === "video");
  const textTrack = spec.tracks.find((t) => t.type === "text");
  const audioTrack = spec.tracks.find((t) => t.type === "audio");
  const currentMusic = audioTrack?.type === "audio" ? audioTrack.clips[0]?.assetId : undefined;

  const selectedVideo =
    selection?.kind === "video" && videoTrack?.type === "video"
      ? videoTrack.clips.find((c) => c.id === selection.clipId)
      : undefined;
  const selectedText =
    selection?.kind === "text" && textTrack?.type === "text"
      ? textTrack.clips.find((c) => c.id === selection.clipId)
      : undefined;

  return (
    <aside
      className="w-full shrink-0 space-y-4 rounded-lg border border-border bg-surface p-4 text-sm lg:w-64"
      aria-label="Properties"
      data-testid="properties-panel"
    >
      {selectedVideo ? (
        <>
          <h3 className="font-medium">Clip</h3>
          <label className="block">
            <span className="text-muted">Duration (s)</span>
            <Input
              type="number"
              step={0.1}
              min={0.3}
              data-testid="prop-duration"
              value={selectedVideo.duration}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (Number.isFinite(v) && v > 0) {
                  trimClip(
                    selectedVideo.id,
                    v,
                    assets[selectedVideo.assetId]?.durationSec ?? undefined,
                  );
                }
              }}
            />
          </label>
          {selectedVideo.kind === "video" ? (
            <label className="block">
              <span className="text-muted">Speed</span>
              <Input
                type="number"
                step={0.05}
                min={0.25}
                max={4}
                value={selectedVideo.speed}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (Number.isFinite(v) && v >= 0.25 && v <= 4) {
                    updateClip(selectedVideo.id, { speed: v });
                  }
                }}
              />
            </label>
          ) : null}
          <label className="block">
            <span className="text-muted">Transition after</span>
            <select
              className="mt-1 h-9 w-full rounded-lg border border-border bg-surface px-2"
              data-testid="prop-transition"
              value={selectedVideo.transitionAfter?.type ?? "cut"}
              onChange={(e) => {
                const type = e.target.value as (typeof TRANSITION_TYPES)[number];
                updateClip(selectedVideo.id, {
                  transitionAfter:
                    type === "cut" ? { type: "cut", duration: 0 } : { type, duration: 0.3 },
                });
              }}
            >
              {TRANSITION_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <Button variant="destructive" size="sm" onClick={deleteSelected}>
            Delete clip
          </Button>
        </>
      ) : selectedText ? (
        <>
          <h3 className="font-medium">Text</h3>
          <label className="block">
            <span className="text-muted">Content</span>
            <Input
              data-testid="prop-text"
              value={selectedText.text}
              onChange={(e) => updateText(selectedText.id, { text: e.target.value })}
            />
          </label>
          <label className="block">
            <span className="text-muted">Style</span>
            <select
              className="mt-1 h-9 w-full rounded-lg border border-border bg-surface px-2"
              value={selectedText.styleId}
              onChange={(e) => updateText(selectedText.id, { styleId: e.target.value })}
            >
              {TEXT_STYLES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="text-muted">Start</span>
              <Input
                type="number"
                step={0.1}
                min={0}
                value={selectedText.start}
                onChange={(e) => updateText(selectedText.id, { start: Number(e.target.value) })}
              />
            </label>
            <label className="block">
              <span className="text-muted">End</span>
              <Input
                type="number"
                step={0.1}
                min={0}
                value={selectedText.end}
                onChange={(e) => updateText(selectedText.id, { end: Number(e.target.value) })}
              />
            </label>
          </div>
          <label className="block">
            <span className="text-muted">Position</span>
            <select
              className="mt-1 h-9 w-full rounded-lg border border-border bg-surface px-2"
              value={selectedText.pos}
              onChange={(e) =>
                updateText(selectedText.id, { pos: e.target.value as "center" | "lower" | "upper" })
              }
            >
              <option value="center">center</option>
              <option value="lower">lower</option>
              <option value="upper">upper</option>
            </select>
          </label>
          <Button variant="destructive" size="sm" onClick={deleteSelected}>
            Delete text
          </Button>
        </>
      ) : (
        <p className="text-muted">Select a clip on the timeline to edit it.</p>
      )}

      <hr className="border-border" />
      <h3 className="font-medium">Music</h3>
      <select
        className="h-9 w-full rounded-lg border border-border bg-surface px-2"
        data-testid="music-select"
        value={currentMusic ?? ""}
        onChange={(e) => replaceMusic(e.target.value || null)}
      >
        <option value="">No music</option>
        {music?.tracks.map((t) => (
          <option key={t.id} value={t.id}>
            ♫ {t.title}
          </option>
        ))}
        {music?.uploads.map((t) => (
          <option key={t.id} value={t.id}>
            ⬆ {t.title}
          </option>
        ))}
      </select>
    </aside>
  );
}
