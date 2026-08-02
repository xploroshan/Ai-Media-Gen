import { z } from "zod";

/** API error envelope — all API errors are `{error:{code,message}}` (CLAUDE.md). */
export const ApiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

export function apiError(code: string, message: string): ApiError {
  return { error: { code, message } };
}

export const MEDIA_KINDS = ["image", "video", "audio"] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

export const ASSET_STATUSES = ["uploading", "analyzing", "ready", "failed"] as const;

export const GEN_KINDS = ["t2i", "i2v", "t2v", "tts", "music"] as const;
export type GenKind = (typeof GEN_KINDS)[number];

export const PLANS = ["free", "creator", "business"] as const;
export type Plan = (typeof PLANS)[number];

export const PLAN_LIMITS: Record<
  Plan,
  {
    watermark: boolean;
    maxResolution: "720p" | "1080p";
    monthlyCredits: number;
    autoEditsPerMonth: number | null;
  }
> = {
  free: { watermark: true, maxResolution: "720p", monthlyCredits: 30, autoEditsPerMonth: 5 },
  creator: {
    watermark: false,
    maxResolution: "1080p",
    monthlyCredits: 300,
    autoEditsPerMonth: null,
  },
  business: {
    watermark: false,
    maxResolution: "1080p",
    monthlyCredits: 300,
    autoEditsPerMonth: null,
  },
};

export const RESOLUTIONS = ["720p", "1080p"] as const;
export type Resolution = (typeof RESOLUTIONS)[number];
