import { z } from "zod";

/** Boot-time env validation (SPEC §11.1) — import from any server module; fails fast. */
const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  S3_ENDPOINT: z.string().url(),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_REGION: z.string().default("us-east-1"),
  S3_BUCKET_ORIGINALS: z.string().default("originals"),
  S3_BUCKET_DERIVED: z.string().default("derived"),
  S3_BUCKET_RENDERS: z.string().default("renders"),
  S3_BUCKET_GENERATED: z.string().default("generated"),
  AUTH_SECRET: z.string().min(16),
  GOOGLE_CLIENT_ID: z.string().optional().default(""),
  GOOGLE_CLIENT_SECRET: z.string().optional().default(""),
  RESEND_API_KEY: z.string().optional().default(""),
  FAL_KEY: z.string().optional().default(""),
  APP_URL: z.string().url().default("http://localhost:3000"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  const missing = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
  throw new Error(`Invalid environment: ${missing}. See .env.example.`);
}

export const env = parsed.data;

/** Dev mode = OTP to console + dev-only helper endpoints. */
export const isDevAuth = !env.RESEND_API_KEY && env.NODE_ENV !== "production";
