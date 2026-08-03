import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { emailOTP } from "better-auth/plugins";
import { prisma } from "./db";
import { env, isDevAuth } from "./env";
import { rememberOtp } from "./otp-store";

async function sendOtpEmail(email: string, otp: string): Promise<void> {
  if (isDevAuth) {
    // Dev mode (SPEC §3): print OTP to console; also kept for /api/dev/last-otp (DECISIONS.md #5)
    console.log(`[auth] OTP for ${email}: ${otp}`);
    rememberOtp(email, otp);
    return;
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: "ReelForge <auth@reelforge.app>",
      to: [email],
      subject: `Your ReelForge sign-in code: ${otp}`,
      text: `Your one-time sign-in code is ${otp}. It expires in 5 minutes.`,
    }),
  });
  if (!res.ok) {
    throw new Error(`Failed to send OTP email (${res.status})`);
  }
}

export const auth = betterAuth({
  database: prismaAdapter(prisma, { provider: "postgresql" }),
  secret: env.AUTH_SECRET,
  baseURL: env.APP_URL,
  user: { modelName: "user" },
  socialProviders:
    env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
      ? {
          google: {
            clientId: env.GOOGLE_CLIENT_ID,
            clientSecret: env.GOOGLE_CLIENT_SECRET,
          },
        }
      : {},
  plugins: [
    emailOTP({
      otpLength: 6,
      expiresIn: 300,
      async sendVerificationOTP({ email, otp }) {
        await sendOtpEmail(email, otp);
      },
    }),
  ],
  databaseHooks: {
    user: {
      create: {
        after: async (user) => {
          // Signup bonus: Profile with 120 credits + matching ledger row (SPEC §4, §8.4)
          await prisma.$transaction(async (tx) => {
            const existing = await tx.profile.findUnique({ where: { id: user.id } });
            if (existing) return;
            await tx.profile.create({
              data: { id: user.id, displayName: user.name || null, creditsBalance: 120 },
            });
            await tx.creditLedger.create({
              data: {
                ownerId: user.id,
                delta: 120,
                reason: "signup_bonus",
                balanceAfter: 120,
              },
            });
          });
        },
      },
    },
  },
});

export type Session = typeof auth.$Infer.Session;
