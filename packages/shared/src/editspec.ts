import { z } from "zod";

/**
 * Edit-Spec v1 — SPEC.md §5.1. The ONLY representation of an edit anywhere in
 * the system. Editor (web) and renderer (worker) both consume exactly this.
 */

export const ASPECTS = ["9:16", "1:1", "4:5", "16:9"] as const;
export const TRANSITION_TYPES = ["cut", "fade", "slideleft", "zoom"] as const;
export const TEXT_POSITIONS = ["center", "lower", "upper"] as const;
export const TEXT_ANIMATIONS = ["pop", "fade", "none"] as const;

export const TransformSchema = z.object({
  scale: z.number().positive().default(1.0),
  x: z.number().default(0),
  y: z.number().default(0),
  rotate: z.number().default(0),
});

export const KenBurnsSchema = z.object({
  fromScale: z.number().positive(),
  toScale: z.number().positive(),
  panX: z.number().default(0),
  panY: z.number().default(0),
});

export const TransitionSchema = z.object({
  type: z.enum(TRANSITION_TYPES),
  duration: z.number().min(0).max(2).default(0.3),
});

export const VideoClipSchema = z.object({
  id: z.string().min(1),
  assetId: z.string().min(1),
  kind: z.enum(["video", "image"]),
  timelineStart: z.number().min(0),
  duration: z.number().positive(),
  srcIn: z.number().min(0).optional(),
  srcOut: z.number().min(0).optional(),
  speed: z.number().min(0.25).max(4).default(1.0),
  transform: TransformSchema.default({ scale: 1.0, x: 0, y: 0, rotate: 0 }),
  kenBurns: KenBurnsSchema.optional(), // images only
  transitionAfter: TransitionSchema.optional(),
});

export const TextClipSchema = z.object({
  id: z.string().min(1),
  text: z.string(),
  start: z.number().min(0),
  end: z.number().min(0),
  styleId: z.string().min(1),
  pos: z.enum(TEXT_POSITIONS).default("center"),
  animate: z.enum(TEXT_ANIMATIONS).default("none"),
});

export const AudioClipSchema = z.object({
  id: z.string().min(1),
  assetId: z.string().min(1),
  timelineStart: z.number().min(0),
  srcIn: z.number().min(0).default(0),
  gainDb: z.number().default(0),
  duckUnderSpeechDb: z.number().max(0).default(-10),
});

export const VideoTrackSchema = z.object({
  id: z.string().min(1),
  type: z.literal("video"),
  clips: z.array(VideoClipSchema),
});

export const TextTrackSchema = z.object({
  id: z.string().min(1),
  type: z.literal("text"),
  clips: z.array(TextClipSchema),
});

export const AudioTrackSchema = z.object({
  id: z.string().min(1),
  type: z.literal("audio"),
  clips: z.array(AudioClipSchema),
});

export const TrackSchema = z.discriminatedUnion("type", [
  VideoTrackSchema,
  TextTrackSchema,
  AudioTrackSchema,
]);

export const CaptionWordSchema = z.object({
  w: z.string(),
  s: z.number().min(0),
  e: z.number().min(0),
});

export const CaptionsSchema = z.object({
  enabled: z.boolean().default(false),
  styleId: z.string().default("karaoke-yellow"),
  lang: z.string().default("en"),
  words: z.array(CaptionWordSchema).default([]),
});

export const ColorSchema = z.object({
  lut: z.string().nullable().default(null),
  brightness: z.number().min(-1).max(1).default(0),
  contrast: z.number().min(-1).max(1).default(0),
  saturation: z.number().min(-1).max(1).default(0),
});

export const EditSpecMetaSchema = z.object({
  vibeId: z.string().optional(),
  seed: z.number().int().default(0),
  beatTimes: z.array(z.number().min(0)).default([]),
  eventTitle: z.string().optional(),
  musicTrackId: z.string().optional(),
});

/** Clip-layout invariants: non-overlapping, sorted, within timeline. */
function checkVideoTrackLayout(
  spec: { tracks: Track[]; durationSec: number },
  ctx: z.RefinementCtx,
): void {
  const videoTracks = spec.tracks.filter((t) => t.type === "video");
  if (videoTracks.length > 1) {
    ctx.addIssue({
      code: "custom",
      message: "v1 allows a single video track (overlay track is P2+)",
      path: ["tracks"],
    });
  }
  for (const track of spec.tracks) {
    if (track.type === "text") continue; // text clips may overlap visually distinct positions
    const clips = track.clips as { timelineStart: number; duration?: number; id: string }[];
    let prevEnd = -Infinity;
    let prevStart = -Infinity;
    for (const clip of clips) {
      if (clip.timelineStart < prevStart) {
        ctx.addIssue({
          code: "custom",
          message: `track ${track.id}: clips must be sorted by timelineStart`,
          path: ["tracks"],
        });
        break;
      }
      if (track.type === "video" && clip.timelineStart < prevEnd - 1e-6) {
        ctx.addIssue({
          code: "custom",
          message: `track ${track.id}: clip ${clip.id} overlaps previous clip`,
          path: ["tracks"],
        });
        break;
      }
      prevStart = clip.timelineStart;
      prevEnd = clip.timelineStart + (clip.duration ?? 0);
    }
  }
  for (const track of videoTracks) {
    for (const clip of track.clips) {
      if (clip.kind === "video" && clip.srcIn !== undefined && clip.srcOut !== undefined) {
        if (clip.srcOut <= clip.srcIn) {
          ctx.addIssue({
            code: "custom",
            message: `clip ${clip.id}: srcOut must be > srcIn`,
            path: ["tracks"],
          });
        }
      }
    }
  }
}

export const EditSpecSchema = z
  .object({
    version: z.literal(1),
    aspect: z.enum(ASPECTS),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    fps: z.number().positive().max(60),
    durationSec: z.number().positive(),
    tracks: z.array(TrackSchema),
    captions: CaptionsSchema.prefault({}),
    color: ColorSchema.prefault({}),
    watermark: z.object({ enabled: z.boolean() }).default({ enabled: true }),
    meta: EditSpecMetaSchema.prefault({}),
  })
  .superRefine(checkVideoTrackLayout);

export type Transform = z.infer<typeof TransformSchema>;
export type KenBurns = z.infer<typeof KenBurnsSchema>;
export type Transition = z.infer<typeof TransitionSchema>;
export type VideoClip = z.infer<typeof VideoClipSchema>;
export type TextClip = z.infer<typeof TextClipSchema>;
export type AudioClip = z.infer<typeof AudioClipSchema>;
export type VideoTrack = z.infer<typeof VideoTrackSchema>;
export type TextTrack = z.infer<typeof TextTrackSchema>;
export type AudioTrack = z.infer<typeof AudioTrackSchema>;
export type Track = z.infer<typeof TrackSchema>;
export type Captions = z.infer<typeof CaptionsSchema>;
export type CaptionWord = z.infer<typeof CaptionWordSchema>;
export type EditSpec = z.infer<typeof EditSpecSchema>;

export const EDIT_SPEC_JSON_SCHEMA = z.toJSONSchema(EditSpecSchema, { io: "input" });

export function parseEditSpec(data: unknown): EditSpec {
  return EditSpecSchema.parse(data);
}

export function safeParseEditSpec(data: unknown) {
  return EditSpecSchema.safeParse(data);
}

export const ASPECT_DIMENSIONS: Record<
  (typeof ASPECTS)[number],
  { width: number; height: number }
> = {
  "9:16": { width: 1080, height: 1920 },
  "1:1": { width: 1080, height: 1080 },
  "4:5": { width: 1080, height: 1350 },
  "16:9": { width: 1920, height: 1080 },
};

/** Minimal valid empty spec for a new project. */
export function emptyEditSpec(aspect: (typeof ASPECTS)[number] = "9:16"): EditSpec {
  const { width, height } = ASPECT_DIMENSIONS[aspect];
  return EditSpecSchema.parse({
    version: 1,
    aspect,
    width,
    height,
    fps: 30,
    durationSec: 1,
    tracks: [
      { id: "v1", type: "video", clips: [] },
      { id: "t1", type: "text", clips: [] },
      { id: "a1", type: "audio", clips: [] },
    ],
  });
}
