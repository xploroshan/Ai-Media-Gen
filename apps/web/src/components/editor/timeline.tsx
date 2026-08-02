"use client";

import { useCallback, useRef, useState } from "react";
import { snapToBeat } from "@/lib/editor/ops";
import { useEditorStore } from "@/lib/editor/store";
import type { AssetMap } from "./preview-canvas";

const PX_PER_SEC = 48;

/** Timeline (SPEC §7): ruler + beat ticks, video/text/audio rows, trim/drag/select. */
export function Timeline({ assets }: { assets: AssetMap }) {
  const spec = useEditorStore((s) => s.spec);
  const playhead = useEditorStore((s) => s.playhead);
  const selection = useEditorStore((s) => s.selection);
  const select = useEditorStore((s) => s.select);
  const setPlayhead = useEditorStore((s) => s.setPlayhead);
  const trimClip = useEditorStore((s) => s.trimClip);
  const reorderClip = useEditorStore((s) => s.reorderClip);
  const updateText = useEditorStore((s) => s.updateText);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  const onRulerPointer = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const t = (e.clientX - rect.left + (scrollRef.current?.scrollLeft ?? 0) * 0) / PX_PER_SEC;
      setPlayhead(Math.max(0, t));
    },
    [setPlayhead],
  );

  if (!spec) return null;
  const videoTrack = spec.tracks.find((t) => t.type === "video");
  const textTrack = spec.tracks.find((t) => t.type === "text");
  const audioTrack = spec.tracks.find((t) => t.type === "audio");
  const width = Math.max(spec.durationSec * PX_PER_SEC + 80, 400);
  const beats = spec.meta.beatTimes ?? [];

  return (
    <div ref={scrollRef} className="overflow-x-auto rounded-lg border border-border bg-surface p-3">
      <div style={{ width }} data-testid="timeline">
        {/* ruler + beat ticks */}
        <div
          className="relative mb-2 h-6 cursor-pointer select-none border-b border-border"
          onPointerDown={onRulerPointer}
          data-testid="timeline-ruler"
        >
          {Array.from({ length: Math.ceil(spec.durationSec) + 1 }).map((_, s) => (
            <span
              key={s}
              className="absolute top-0 text-[10px] text-muted"
              style={{ left: s * PX_PER_SEC }}
            >
              {s}s
            </span>
          ))}
          {beats.map((b, i) => (
            <span
              key={i}
              className="absolute bottom-0 h-1.5 w-px bg-primary/60"
              style={{ left: b * PX_PER_SEC }}
            />
          ))}
        </div>

        <div className="relative">
          {/* playhead */}
          <div
            className="pointer-events-none absolute inset-y-0 z-20 w-0.5 bg-primary"
            style={{ left: playhead * PX_PER_SEC }}
            data-testid="playhead"
          />

          {/* video row */}
          <div className="relative mb-2 h-16" data-testid="video-row">
            {videoTrack?.type === "video"
              ? videoTrack.clips.map((clip, idx) => {
                  const selected = selection?.kind === "video" && selection.clipId === clip.id;
                  const asset = assets[clip.assetId];
                  return (
                    <div
                      key={clip.id}
                      data-testid={`clip-${idx}`}
                      role="button"
                      tabIndex={0}
                      aria-pressed={selected}
                      draggable
                      onDragStart={() => setDragIndex(idx)}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={() => {
                        if (dragIndex !== null && dragIndex !== idx) reorderClip(dragIndex, idx);
                        setDragIndex(null);
                      }}
                      onClick={() => select({ kind: "video", clipId: clip.id })}
                      onKeyDown={(e) =>
                        e.key === "Enter" && select({ kind: "video", clipId: clip.id })
                      }
                      className={`absolute top-0 h-full overflow-hidden rounded-md border-2 bg-surface-2 ${
                        selected ? "border-primary" : "border-border"
                      }`}
                      style={{
                        left: clip.timelineStart * PX_PER_SEC,
                        width: Math.max(12, clip.duration * PX_PER_SEC - 2),
                      }}
                    >
                      {asset?.posterUrl || (asset?.kind === "image" && asset.url) ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={asset.posterUrl ?? asset.url}
                          alt=""
                          className="h-full w-full object-cover opacity-70"
                          draggable={false}
                        />
                      ) : null}
                      <span className="absolute left-1 top-0.5 text-[9px] text-white/90">
                        {clip.kind === "video" ? "▶" : "🖼"} {clip.duration.toFixed(1)}s
                      </span>
                      {clip.transitionAfter && clip.transitionAfter.type !== "cut" ? (
                        <span className="absolute bottom-0.5 right-1 text-[9px] text-primary">
                          {clip.transitionAfter.type}
                        </span>
                      ) : null}
                      <TrimHandle
                        clip={clip}
                        beats={beats}
                        assetDuration={asset?.durationSec ?? undefined}
                        onTrim={trimClip}
                      />
                    </div>
                  );
                })
              : null}
          </div>

          {/* text row */}
          <div className="relative mb-2 h-8" data-testid="text-row">
            {textTrack?.type === "text"
              ? textTrack.clips.map((clip) => {
                  const selected = selection?.kind === "text" && selection.clipId === clip.id;
                  return (
                    <button
                      key={clip.id}
                      data-testid={`text-clip-${clip.id}`}
                      aria-pressed={selected}
                      onClick={() => select({ kind: "text", clipId: clip.id })}
                      className={`absolute top-0 h-full truncate rounded border px-1 text-left text-[10px] ${
                        selected ? "border-primary bg-primary/20" : "border-border bg-surface-2"
                      }`}
                      style={{
                        left: clip.start * PX_PER_SEC,
                        width: Math.max(24, (clip.end - clip.start) * PX_PER_SEC),
                      }}
                      onDoubleClick={() => {
                        const t = prompt("Edit text", clip.text);
                        if (t !== null) updateText(clip.id, { text: t });
                      }}
                    >
                      T {clip.text}
                    </button>
                  );
                })
              : null}
          </div>

          {/* audio row */}
          <div className="relative h-6" data-testid="audio-row">
            {audioTrack?.type === "audio" && audioTrack.clips.length > 0 ? (
              <div
                className="absolute inset-y-0 rounded bg-success/30 px-1 text-[10px] leading-6"
                style={{ left: 0, width: spec.durationSec * PX_PER_SEC }}
              >
                ♫ music
              </div>
            ) : (
              <span className="text-[10px] text-muted">no music</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function TrimHandle({
  clip,
  beats,
  assetDuration,
  onTrim,
}: {
  clip: { id: string; timelineStart: number; duration: number; speed: number };
  beats: number[];
  assetDuration?: number;
  onTrim: (clipId: string, newDuration: number, assetDuration?: number) => void;
}) {
  const dragging = useRef<{ startX: number; startDur: number } | null>(null);

  return (
    <div
      data-testid={`trim-handle-${clip.id}`}
      className="absolute inset-y-0 right-0 w-2 cursor-ew-resize bg-primary/50 hover:bg-primary"
      onPointerDown={(e) => {
        e.stopPropagation();
        e.currentTarget.setPointerCapture(e.pointerId);
        dragging.current = { startX: e.clientX, startDur: clip.duration };
      }}
      onPointerMove={(e) => {
        if (!dragging.current) return;
        const deltaSec = (e.clientX - dragging.current.startX) / PX_PER_SEC;
        const raw = dragging.current.startDur + deltaSec;
        const end = snapToBeat(clip.timelineStart + raw, beats, 0.12);
        onTrim(clip.id, end - clip.timelineStart, assetDuration);
      }}
      onPointerUp={(e) => {
        e.currentTarget.releasePointerCapture(e.pointerId);
        dragging.current = null;
      }}
    />
  );
}
