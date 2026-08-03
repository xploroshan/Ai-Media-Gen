import { z } from "zod";

/** Job payloads — SPEC.md §5.2. Mirrored in worker/lib/payloads.py. */

export const JOB_TYPES = [
  "analyze_media",
  "detect_events",
  "autoedit_generate",
  "render_preview",
  "render_final",
  "transcribe",
  "beats",
  "generate_ai",
  "image_op",
] as const;

export type JobType = (typeof JOB_TYPES)[number];

export const AnalyzeMediaPayload = z.object({ assetId: z.string().min(1) });
export const DetectEventsPayload = z.object({ ownerId: z.string().min(1) });
export const BeatsPayload = z.object({ assetId: z.string().min(1) });
export const TranscribePayload = z.object({
  assetId: z.string().min(1),
  lang: z.enum(["en", "hi"]).optional(),
});

export const SteeringSchema = z.object({
  pace: z.enum(["slower", "faster"]).optional(),
  peopleBias: z.number().min(-1).max(1).optional(),
  fewerClips: z.boolean().optional(),
  bestMomentsFirst: z.boolean().optional(),
});

export const AutoeditGeneratePayload = z.object({
  projectId: z.string().min(1),
  assetIds: z.array(z.string().min(1)).min(1),
  vibeId: z.string().min(1),
  presetId: z.string().min(1),
  targetSec: z.number().positive(),
  seed: z.number().int(),
  steering: SteeringSchema.optional(),
  excludeAssetIds: z.array(z.string()).optional(), // shuffle: prior picks to penalize
});

export const RenderPayload = z.object({
  projectId: z.string().min(1),
  exportId: z.string().optional(),
});

export const GenerateAiPayload = z.object({ generationId: z.string().min(1) });

export const IMAGE_OPS = ["enhance", "bg_remove", "erase", "upscale"] as const;
export const ImageOpPayload = z.object({
  assetId: z.string().min(1),
  op: z.enum(IMAGE_OPS),
  params: z
    .object({
      maskKey: z.string().optional(),
    })
    .catchall(z.unknown())
    .default({}),
});

export const JOB_PAYLOAD_SCHEMAS = {
  analyze_media: AnalyzeMediaPayload,
  detect_events: DetectEventsPayload,
  beats: BeatsPayload,
  transcribe: TranscribePayload,
  autoedit_generate: AutoeditGeneratePayload,
  render_preview: RenderPayload,
  render_final: RenderPayload,
  generate_ai: GenerateAiPayload,
  image_op: ImageOpPayload,
} as const satisfies Record<JobType, z.ZodType>;

export type Steering = z.infer<typeof SteeringSchema>;

export const JOB_STATUSES = ["queued", "running", "done", "failed", "canceled"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
