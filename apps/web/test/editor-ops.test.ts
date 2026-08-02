import { beforeEach, describe, expect, it } from "vitest";
import { EditSpecSchema, type EditSpec } from "@reelforge/shared";
import * as ops from "../src/lib/editor/ops";
import { HISTORY_LIMIT, useEditorStore } from "../src/lib/editor/store";

function sampleSpec(): EditSpec {
  return EditSpecSchema.parse({
    version: 1,
    aspect: "9:16",
    width: 1080,
    height: 1920,
    fps: 30,
    durationSec: 6,
    tracks: [
      {
        id: "v1",
        type: "video",
        clips: [
          {
            id: "c1",
            assetId: "a1",
            kind: "video",
            timelineStart: 0,
            duration: 2,
            srcIn: 1,
            srcOut: 3,
            speed: 1,
            transitionAfter: { type: "fade", duration: 0.3 },
          },
          { id: "c2", assetId: "a2", kind: "image", timelineStart: 2, duration: 2 },
          {
            id: "c3",
            assetId: "a3",
            kind: "video",
            timelineStart: 4,
            duration: 2,
            srcIn: 0,
            srcOut: 2,
            speed: 1,
          },
        ],
      },
      {
        id: "t1",
        type: "text",
        clips: [{ id: "x1", text: "Hello", start: 0.5, end: 2, styleId: "title-bold" }],
      },
      {
        id: "a1",
        type: "audio",
        clips: [{ id: "m1", assetId: "music1", timelineStart: 0, srcIn: 0 }],
      },
    ],
  });
}

describe("editor ops (pure)", () => {
  it("trim video clip adjusts duration + srcOut and re-flows timeline", () => {
    const next = ops.trimClip(sampleSpec(), "c1", 1.0);
    const track = ops.videoTrack(next);
    expect(track.clips[0]!.duration).toBe(1.0);
    expect(track.clips[0]!.srcOut).toBe(2.0); // srcIn 1 + 1s
    expect(track.clips[1]!.timelineStart).toBe(1.0);
    expect(track.clips[2]!.timelineStart).toBe(3.0);
    expect(next.durationSec).toBe(5.0);
    expect(EditSpecSchema.safeParse(next).success).toBe(true);
  });

  it("trim clamps to asset duration", () => {
    const next = ops.trimClip(sampleSpec(), "c1", 10, 4.0); // asset only 4s, srcIn 1
    expect(ops.videoTrack(next).clips[0]!.srcOut).toBe(4.0);
    expect(ops.videoTrack(next).clips[0]!.duration).toBe(3.0);
  });

  it("trim never mutates the input spec", () => {
    const spec = sampleSpec();
    const json = JSON.stringify(spec);
    ops.trimClip(spec, "c1", 1.0);
    expect(JSON.stringify(spec)).toBe(json);
  });

  it("split divides a clip and its source window at the playhead", () => {
    const next = ops.splitAt(sampleSpec(), 1.0);
    const clips = ops.videoTrack(next).clips;
    expect(clips).toHaveLength(4);
    expect(clips[0]!.duration).toBe(1.0);
    expect(clips[0]!.srcOut).toBe(2.0);
    expect(clips[1]!.srcIn).toBe(2.0);
    expect(clips[1]!.duration).toBe(1.0);
    expect(next.durationSec).toBe(6.0); // total unchanged
    expect(EditSpecSchema.safeParse(next).success).toBe(true);
  });

  it("split near an edge is a no-op", () => {
    const spec = sampleSpec();
    expect(ops.splitAt(spec, 0.05)).toBe(spec);
    expect(ops.splitAt(spec, 2.0)).toBe(spec); // exactly on boundary
  });

  it("delete removes clip and closes the gap", () => {
    const next = ops.deleteClip(sampleSpec(), "c2");
    const clips = ops.videoTrack(next).clips;
    expect(clips.map((c) => c.id)).toEqual(["c1", "c3"]);
    expect(clips[1]!.timelineStart).toBe(2.0);
    expect(next.durationSec).toBe(4.0);
  });

  it("refuses to delete the last remaining clip", () => {
    let spec = sampleSpec();
    spec = ops.deleteClip(spec, "c1");
    spec = ops.deleteClip(spec, "c2");
    const again = ops.deleteClip(spec, "c3");
    expect(ops.videoTrack(again).clips).toHaveLength(1);
  });

  it("reorder moves clips and re-flows", () => {
    const next = ops.reorderClip(sampleSpec(), 0, 2);
    const clips = ops.videoTrack(next).clips;
    expect(clips.map((c) => c.id)).toEqual(["c2", "c3", "c1"]);
    expect(clips[0]!.timelineStart).toBe(0);
    // last clip must not carry a transition
    expect(clips[2]!.transitionAfter).toBeUndefined();
  });

  it("addText inserts at playhead, updateText edits, deleteText removes", () => {
    let spec = ops.addTextClip(sampleSpec(), 3.0, "pop-bold-yellow");
    const texts = () => {
      const t = spec.tracks.find((tr) => tr.type === "text");
      if (t?.type !== "text") throw new Error("no text track");
      return t.clips;
    };
    expect(texts()).toHaveLength(2);
    const added = texts().find((c) => c.id !== "x1")!;
    expect(added.start).toBeCloseTo(3.0, 5);
    spec = ops.updateTextClip(spec, added.id, { text: "Goa!" });
    expect(texts().find((c) => c.id === added.id)!.text).toBe("Goa!");
    spec = ops.deleteTextClip(spec, added.id);
    expect(texts()).toHaveLength(1);
  });

  it("replaceMusic swaps the audio clip and clearing removes it", () => {
    let spec = ops.replaceMusic(sampleSpec(), "newTrack");
    const audio = () => {
      const t = spec.tracks.find((tr) => tr.type === "audio");
      if (t?.type !== "audio") throw new Error("no audio track");
      return t.clips;
    };
    expect(audio()[0]!.assetId).toBe("newTrack");
    expect(spec.meta.musicTrackId).toBe("newTrack");
    spec = ops.replaceMusic(spec, null);
    expect(audio()).toHaveLength(0);
  });

  it("snapToBeat snaps within tolerance only", () => {
    const beats = [0, 0.5, 1.0, 1.5];
    expect(ops.snapToBeat(0.52, beats)).toBe(0.5);
    expect(ops.snapToBeat(0.75, beats, 0.1)).toBe(0.75);
  });
});

describe("undo/redo state machine (P3 exit test)", () => {
  beforeEach(() => {
    useEditorStore.getState().load(sampleSpec());
  });

  const store = () => useEditorStore.getState();

  it("undo restores previous state, redo reapplies", () => {
    store().trimClip("c1", 1.0);
    expect(store().spec!.durationSec).toBe(5.0);
    store().undo();
    expect(store().spec!.durationSec).toBe(6.0);
    store().redo();
    expect(store().spec!.durationSec).toBe(5.0);
  });

  it("new edit clears the redo stack", () => {
    store().trimClip("c1", 1.0);
    store().undo();
    store().trimClip("c1", 1.5);
    store().redo(); // nothing to redo
    const clips = ops.videoTrack(store().spec!).clips;
    expect(clips[0]!.duration).toBe(1.5);
    expect(store().future).toHaveLength(0);
  });

  it("undo at empty history is a no-op", () => {
    const before = store().spec;
    store().undo();
    expect(store().spec).toBe(before);
  });

  it("history is capped at 50 entries", () => {
    for (let i = 0; i < 60; i++) {
      store().trimClip("c2", 1 + (i % 5) * 0.1);
    }
    expect(store().past.length).toBeLessThanOrEqual(HISTORY_LIMIT);
    // undoing to the bottom of the stack still works
    for (let i = 0; i < HISTORY_LIMIT + 5; i++) store().undo();
    expect(store().spec).not.toBeNull();
  });

  it("delete selection + undo restores the clip", () => {
    store().select({ kind: "video", clipId: "c2" });
    store().deleteSelected();
    expect(ops.videoTrack(store().spec!).clips).toHaveLength(2);
    store().undo();
    expect(ops.videoTrack(store().spec!).clips).toHaveLength(3);
  });

  it("splitAtPlayhead splits at the current playhead", () => {
    store().setPlayhead(1.0);
    store().splitAtPlayhead();
    expect(ops.videoTrack(store().spec!).clips).toHaveLength(4);
    store().undo();
    expect(ops.videoTrack(store().spec!).clips).toHaveLength(3);
  });

  it("marks dirty on edit, clean after markSaved", () => {
    expect(store().dirty).toBe(false);
    store().trimClip("c1", 1.2);
    expect(store().dirty).toBe(true);
    store().markSaved();
    expect(store().dirty).toBe(false);
  });
});
