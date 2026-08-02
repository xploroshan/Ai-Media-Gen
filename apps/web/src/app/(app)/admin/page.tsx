import { requireAdmin } from "@/lib/session";

export default async function AdminPage() {
  await requireAdmin();
  return (
    <div>
      <h1 className="mb-2 text-2xl font-semibold">Admin</h1>
      <p className="text-sm text-muted">
        Jobs dashboard, feature flags, model routing and credit adjustments. (Arrives in P7.)
      </p>
    </div>
  );
}
