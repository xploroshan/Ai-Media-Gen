"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";

export default function LoginPage() {
  const router = useRouter();
  const [step, setStep] = useState<"email" | "otp">("email");
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function sendOtp(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error: err } = await authClient.emailOtp.sendVerificationOtp({
      email,
      type: "sign-in",
    });
    setBusy(false);
    if (err) {
      setError(err.message ?? "Could not send code");
      return;
    }
    setStep("otp");
  }

  async function verifyOtp(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error: err } = await authClient.signIn.emailOtp({ email, otp });
    setBusy(false);
    if (err) {
      setError(err.message ?? "Invalid code");
      return;
    }
    router.push("/library");
    router.refresh();
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardTitle className="mb-1">ReelForge</CardTitle>
        <CardDescription className="mb-6">
          Turn your photos &amp; videos into beat-synced reels.
        </CardDescription>

        {step === "email" ? (
          <form onSubmit={sendOtp} className="space-y-3" aria-label="Email sign in">
            <label className="block text-sm text-muted" htmlFor="email">
              Email address
            </label>
            <Input
              id="email"
              type="email"
              required
              autoFocus
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <Button type="submit" className="w-full" disabled={busy || !email}>
              {busy ? "Sending…" : "Send sign-in code"}
            </Button>
          </form>
        ) : (
          <form onSubmit={verifyOtp} className="space-y-3" aria-label="Enter code">
            <p className="text-sm text-muted">
              We sent a 6-digit code to <span className="text-foreground">{email}</span>.
            </p>
            <label className="block text-sm text-muted" htmlFor="otp">
              Code
            </label>
            <Input
              id="otp"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              required
              autoFocus
              placeholder="123456"
              value={otp}
              onChange={(e) => setOtp(e.target.value)}
            />
            <Button type="submit" className="w-full" disabled={busy || otp.length !== 6}>
              {busy ? "Verifying…" : "Sign in"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="w-full"
              onClick={() => {
                setStep("email");
                setOtp("");
              }}
            >
              Use a different email
            </Button>
          </form>
        )}

        {error ? (
          <p role="alert" className="mt-3 text-sm text-danger">
            {error}
          </p>
        ) : null}
      </Card>
    </main>
  );
}
