"use client";

import { useEffect, useMemo, useRef } from "react";
import type { EditSpec, TextClip, VideoClip } from "@reelforge/shared";
import { useEditorStore } from "@/lib/editor/store";

export type AssetMap = Record<
  string,
  { kind: string; url: string; posterUrl?: string; durationSec: number | null }
>;

/**
 * rAF-driven DOM preview (SPEC §7): the active clip's media positioned in an
 * aspect-correct letterboxed stage; kenBurns as CSS transforms; text clips as
 * styled DOM; transitions preview as hard cuts with a badge. No WebCodecs (v1).
 */
export function PreviewCanvas({ assets }: { assets: AssetMap }) {
  const spec = useEditorStore((s) => s.spec);
  const playing = useEditorStore((s) => s.playing);
  const playhead = useEditorStore((s) => s.playhead);
  const setPlayhead = useEditorStore((s) => s.setPlayhead);
  const setPlaying = useEditorStore((s) => s.setPlaying);

  const rafRef = useRef<number>(0);
  const lastTick = useRef<number>(0);
  const videoRefs = useRef<Map<string, HTMLVideoElement>>(new Map());

  // rAF clock
  useEffect(() => {
    if (!playing) return;
    lastTick.current = performance.now();
    const loop = (now: number) => {
      const dt = (now - lastTick.current) / 1000;
      lastTick.current = now;
      const { playhead: t, spec: s } = useEditorStore.getState();
      if (!s) return;
      const next = t + dt;
      if (next >= s.durationSec) {
        setPlayhead(s.durationSec);
        setPlaying(false);
        return;
      }
      setPlayhead(next);
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [playing, setPlayhead, setPlaying]);

  const active = useMemo(() => {
    if (!spec) return null;
    const track = spec.tracks.find((t) => t.type === "video");
    if (track?.type !== "video") return null;
    const clip =
      track.clips.find(
        (c) => playhead >= c.timelineStart && playhead < c.timelineStart + c.duration,
      ) ?? track.clips[track.clips.length - 1];
    return clip ?? null;
  }, [spec, playhead]);

  // keep the active <video> element seeked/synced
  useEffect(() => {
    if (!active || active.kind !== "video") return;
    const el = videoRefs.current.get(active.id);
    if (!el) return;
    const local = playhead - active.timelineStart;
    const target = (active.srcIn ?? 0) + local * active.speed;
    if (Math.abs(el.currentTime - target) > 0.3) {
      el.currentTime = target;
    }
    if (playing && el.paused) void el.play().catch(() => undefined);
    if (!playing && !el.paused) el.pause();
  }, [active, playhead, playing]);

  if (!spec) return null;

  const activeTexts: TextClip[] = (() => {
    const track = spec.tracks.find((t) => t.type === "text");
    if (track?.type !== "text") return [];
    return track.clips.filter((c) => playhead >= c.start && playhead <= c.end);
  })();

  const nearingTransition =
    active?.transitionAfter &&
    active.transitionAfter.type !== "cut" &&
    playhead > active.timelineStart + active.duration - 1.0;

  const aspectRatio = spec.width / spec.height;

  return (
    <div
      className="relative mx-auto flex h-full max-h-[52vh] items-center justify-center"
      data-testid="preview-canvas"
    >
      <div
        className="relative overflow-hidden rounded-lg bg-black"
        style={{ aspectRatio: `${aspectRatio}`, height: "100%" }}
      >
        {active ? (
          <ClipLayer
            key={active.id}
            clip={active}
            assets={assets}
            playhead={playhead}
            videoRefs={videoRefs}
          />
        ) : null}

        {activeTexts.map((clip) => (
          <TextLayer key={clip.id} clip={clip} />
        ))}

        {nearingTransition ? (
          <span
            className="absolute right-2 top-2 rounded bg-black/70 px-2 py-0.5 text-[10px] text-white"
            data-testid="transition-badge"
          >
            transition: {active!.transitionAfter!.type} (final render only)
          </span>
        ) : null}
      </div>
    </div>
  );
}

function ClipLayer({
  clip,
  assets,
  playhead,
  videoRefs,
}: {
  clip: VideoClip;
  assets: AssetMap;
  playhead: number;
  videoRefs: React.MutableRefObject<Map<string, HTMLVideoElement>>;
}) {
  const asset = assets[clip.assetId];
  if (!asset) {
    return (
      <div className="flex h-full w-full items-center justify-center text-xs text-muted">
        missing media
      </div>
    );
  }
  if (clip.kind === "video") {
    return (
      <video
        ref={(el) => {
          if (el) videoRefs.current.set(clip.id, el);
          else videoRefs.current.delete(clip.id);
        }}
        src={asset.url}
        poster={asset.posterUrl}
        muted
        playsInline
        preload="auto"
        className="h-full w-full object-cover"
      />
    );
  }
  // image with kenBurns via CSS transform driven by local progress
  const progress = Math.min(1, Math.max(0, (playhead - clip.timelineStart) / clip.duration));
  const kb = clip.kenBurns ?? { fromScale: 1, toScale: 1, panX: 0, panY: 0 };
  const scale = kb.fromScale + (kb.toScale - kb.fromScale) * progress;
  const tx = kb.panX * 100 * progress;
  const ty = kb.panY * 100 * progress;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={asset.url}
      alt=""
      className="h-full w-full object-cover"
      style={{ transform: `scale(${scale}) translate(${tx}%, ${ty}%)` }}
    />
  );
}

const TEXT_STYLE_CSS: Record<string, React.CSSProperties> = {
  "title-bold": { fontWeight: 800, color: "#fff" },
  "title-serif-white": { fontFamily: "serif", color: "#fff" },
  "pop-bold-yellow": { fontWeight: 800, color: "#ffe500" },
  "clean-sans-brand": { fontWeight: 500, color: "#eaf0f5" },
};

function TextLayer({ clip }: { clip: TextClip }) {
  const pos =
    clip.pos === "upper"
      ? "top-[12%]"
      : clip.pos === "lower"
        ? "bottom-[12%]"
        : "top-1/2 -translate-y-1/2";
  return (
    <div
      className={`pointer-events-none absolute inset-x-0 ${pos} px-4 text-center`}
      data-testid="preview-text"
    >
      <span
        className="text-xl drop-shadow-[0_2px_4px_rgba(0,0,0,0.8)]"
        style={TEXT_STYLE_CSS[clip.styleId] ?? TEXT_STYLE_CSS["title-bold"]}
      >
        {clip.text}
      </span>
    </div>
  );
}
