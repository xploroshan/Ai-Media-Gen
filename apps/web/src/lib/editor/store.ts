"use client";

import { create } from "zustand";
import type { EditSpec, TextClip, VideoClip } from "@reelforge/shared";
import * as ops from "./ops";

/** Editor state + undo/redo (50 steps, SPEC §7). History stores spec snapshots. */

export const HISTORY_LIMIT = 50;

export type Selection = { kind: "video"; clipId: string } | { kind: "text"; clipId: string } | null;

type EditorState = {
  spec: EditSpec | null;
  past: EditSpec[];
  future: EditSpec[];
  selection: Selection;
  playhead: number;
  playing: boolean;
  dirty: boolean;

  load: (spec: EditSpec) => void;
  commit: (next: EditSpec) => void;
  markSaved: () => void;
  select: (selection: Selection) => void;
  setPlayhead: (t: number) => void;
  setPlaying: (playing: boolean) => void;

  trimClip: (clipId: string, newDuration: number, assetDuration?: number) => void;
  splitAtPlayhead: () => void;
  deleteSelected: () => void;
  reorderClip: (fromIndex: number, toIndex: number) => void;
  updateClip: (clipId: string, patch: Partial<VideoClip>) => void;
  addText: (styleId?: string) => void;
  updateText: (clipId: string, patch: Partial<TextClip>) => void;
  replaceMusic: (assetId: string | null) => void;

  undo: () => void;
  redo: () => void;
};

export const useEditorStore = create<EditorState>((set, get) => ({
  spec: null,
  past: [],
  future: [],
  selection: null,
  playhead: 0,
  playing: false,
  dirty: false,

  load: (spec) =>
    set({ spec, past: [], future: [], selection: null, playhead: 0, playing: false, dirty: false }),

  commit: (next) => {
    const { spec, past } = get();
    if (!spec || next === spec) return;
    set({
      spec: next,
      past: [...past.slice(-(HISTORY_LIMIT - 1)), spec],
      future: [],
      dirty: true,
    });
  },

  markSaved: () => set({ dirty: false }),
  select: (selection) => set({ selection }),
  setPlayhead: (t) => {
    const spec = get().spec;
    const max = spec?.durationSec ?? 0;
    set({ playhead: Math.max(0, Math.min(t, max)) });
  },
  setPlaying: (playing) => set({ playing }),

  trimClip: (clipId, newDuration, assetDuration) => {
    const spec = get().spec;
    if (!spec) return;
    get().commit(ops.trimClip(spec, clipId, newDuration, assetDuration));
  },

  splitAtPlayhead: () => {
    const { spec, playhead } = get();
    if (!spec) return;
    get().commit(ops.splitAt(spec, playhead));
  },

  deleteSelected: () => {
    const { spec, selection } = get();
    if (!spec || !selection) return;
    const next =
      selection.kind === "video"
        ? ops.deleteClip(spec, selection.clipId)
        : ops.deleteTextClip(spec, selection.clipId);
    if (next !== spec) set({ selection: null });
    get().commit(next);
  },

  reorderClip: (fromIndex, toIndex) => {
    const spec = get().spec;
    if (!spec) return;
    get().commit(ops.reorderClip(spec, fromIndex, toIndex));
  },

  updateClip: (clipId, patch) => {
    const spec = get().spec;
    if (!spec) return;
    get().commit(ops.updateClip(spec, clipId, patch));
  },

  addText: (styleId = "title-bold") => {
    const { spec, playhead } = get();
    if (!spec) return;
    const beforeIds = new Set(
      spec.tracks.flatMap((t) => (t.type === "text" ? t.clips.map((c) => c.id) : [])),
    );
    const next = ops.addTextClip(spec, playhead, styleId);
    get().commit(next);
    const track = next.tracks.find((t) => t.type === "text");
    if (track?.type === "text") {
      const added = track.clips.find((c) => !beforeIds.has(c.id));
      if (added) set({ selection: { kind: "text", clipId: added.id } });
    }
  },

  updateText: (clipId, patch) => {
    const spec = get().spec;
    if (!spec) return;
    get().commit(ops.updateTextClip(spec, clipId, patch));
  },

  replaceMusic: (assetId) => {
    const spec = get().spec;
    if (!spec) return;
    get().commit(ops.replaceMusic(spec, assetId));
  },

  undo: () => {
    const { spec, past, future } = get();
    if (!spec || past.length === 0) return;
    const previous = past[past.length - 1]!;
    set({
      spec: previous,
      past: past.slice(0, -1),
      future: [spec, ...future].slice(0, HISTORY_LIMIT),
      dirty: true,
    });
  },

  redo: () => {
    const { spec, past, future } = get();
    if (!spec || future.length === 0) return;
    const next = future[0]!;
    set({
      spec: next,
      past: [...past.slice(-(HISTORY_LIMIT - 1)), spec],
      future: future.slice(1),
      dirty: true,
    });
  },
}));
