import { requireSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { CreditsLedger } from "@/components/settings/credits-ledger";

export default async function SettingsPage() {
  const session = await requireSession();
  const profile = await prisma.profile.findUnique({ where: { id: session.user.id } });

  return (
    <div>
      <h1 className="mb-4 text-2xl font-semibold">Settings</h1>
      <dl className="space-y-2 text-sm">
        <div className="flex gap-2">
          <dt className="text-muted">Email:</dt>
          <dd>{session.user.email}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-muted">Plan:</dt>
          <dd className="capitalize">{profile?.plan ?? "free"}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-muted">Credits:</dt>
          <dd>{profile?.creditsBalance ?? 0}</dd>
        </div>
      </dl>
      <div className="mt-8 max-w-2xl">
        <CreditsLedger />
      </div>
    </div>
  );
}
