import { describe, expect, it } from "vitest";
import {
  EDIT_SPEC_JSON_SCHEMA,
  EditSpecSchema,
  emptyEditSpec,
  parseEditSpec,
  safeParseEditSpec,
  type EditSpec,
} from "../src/editspec";

/** The §5.1 example spec, verbatim shape. */
function exampleSpec(): unknown {
  return {
    version: 1,
    aspect: "9:16",
    width: 1080,
    height: 1920,
    fps: 30,
    durationSec: 30.0,
    tracks: [
      {
        id: "v1",
        type: "video",
        clips: [
          {
            id: "c1",
            assetId: "asset-1",
            kind: "video",
            timelineStart: 0.0,
            duration: 2.4,
            srcIn: 12.2,
            srcOut: 14.6,
            speed: 1.0,
            transform: { scale: 1.0, x: 0, y: 0, rotate: 0 },
            transitionAfter: { type: "fade", duration: 0.3 },
          },
          {
            id: "c2",
            assetId: "asset-2",
            kind: "image",
            timelineStart: 2.4,
            duration: 2.0,
            kenBurns: { fromScale: 1.05, toScale: 1.18, panX: 0.03, panY: 0 },
          },
        ],
      },
      {
        id: "t1",
        type: "text",
        clips: [
          {
            id: "x1",
            text: "Goa 2026",
            start: 0.2,
            end: 2.2,
            styleId: "title-bold",
            pos: "center",
            animate: "pop",
          },
        ],
      },
      {
        id: "a1",
        type: "audio",
        clips: [
          {
            id: "m1",
            assetId: "music-1",
            timelineStart: 0,
            srcIn: 8.0,
            gainDb: 0,
            duckUnderSpeechDb: -10,
          },
        ],
      },
    ],
    captions: {
      enabled: true,
      styleId: "karaoke-yellow",
      lang: "en",
      words: [{ w: "hello", s: 3.21, e: 3.44 }],
    },
    color: { lut: null, brightness: 0, contrast: 0, saturation: 0 },
    watermark: { enabled: true },
    meta: { vibeId: "travel-cinematic", seed: 42, beatTimes: [0.51, 1.02] },
  };
}

describe("EditSpec zod round-trip (P0 exit test)", () => {
  it("parses the §5.1 example and round-trips through JSON identically", () => {
    const parsed = parseEditSpec(exampleSpec());
    const roundTripped = parseEditSpec(JSON.parse(JSON.stringify(parsed)));
    expect(roundTripped).toEqual(parsed);
  });

  it("re-parsing parsed output is idempotent (defaults are stable)", () => {
    const once = parseEditSpec(exampleSpec());
    const twice = parseEditSpec(once);
    expect(twice).toEqual(once);
  });

  it("applies documented defaults", () => {
    const parsed = parseEditSpec(exampleSpec());
    const track = parsed.tracks.find((t) => t.type === "video");
    if (track?.type !== "video") throw new Error("video track missing");
    expect(track.clips[1]?.speed).toBe(1.0);
    expect(track.clips[1]?.transform).toEqual({ scale: 1.0, x: 0, y: 0, rotate: 0 });
  });

  it("rejects a second video track (v1 rule)", () => {
    const spec = exampleSpec() as { tracks: unknown[] };
    spec.tracks = [...spec.tracks, { id: "v2", type: "video", clips: [] }];
    const result = safeParseEditSpec(spec);
    expect(result.success).toBe(false);
  });

  it("rejects overlapping video clips", () => {
    const spec = parseEditSpec(exampleSpec()) as EditSpec;
    const video = spec.tracks.find((t) => t.type === "video");
    if (video?.type !== "video") throw new Error("no video track");
    video.clips[1]!.timelineStart = 1.0; // overlaps clip 1 (0.0–2.4)
    expect(safeParseEditSpec(spec).success).toBe(false);
  });

  it("rejects unsorted clips", () => {
    const spec = parseEditSpec(exampleSpec()) as EditSpec;
    const video = spec.tracks.find((t) => t.type === "video");
    if (video?.type !== "video") throw new Error("no video track");
    video.clips.reverse();
    expect(safeParseEditSpec(spec).success).toBe(false);
  });

  it("rejects srcOut <= srcIn", () => {
    const spec = exampleSpec() as {
      tracks: { clips: { srcIn?: number; srcOut?: number }[] }[];
    };
    spec.tracks[0]!.clips[0]!.srcOut = 12.0; // < srcIn 12.2
    expect(safeParseEditSpec(spec).success).toBe(false);
  });

  it("rejects wrong version", () => {
    const spec = exampleSpec() as { version: number };
    spec.version = 2;
    expect(safeParseEditSpec(spec).success).toBe(false);
  });

  it("exports a JSON Schema document", () => {
    expect(EDIT_SPEC_JSON_SCHEMA).toMatchObject({ type: "object" });
    expect(JSON.stringify(EDIT_SPEC_JSON_SCHEMA)).toContain("durationSec");
  });

  it("emptyEditSpec is valid for every aspect", () => {
    for (const aspect of ["9:16", "1:1", "4:5", "16:9"] as const) {
      const spec = emptyEditSpec(aspect);
      expect(EditSpecSchema.safeParse(spec).success).toBe(true);
      expect(spec.aspect).toBe(aspect);
    }
  });
});
