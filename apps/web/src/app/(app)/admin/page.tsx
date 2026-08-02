import { requireAdmin } from "@/lib/session";
import { AdminDashboard } from "@/components/admin/admin-dashboard";

export default async function AdminPage() {
  await requireAdmin();
  return (
    <div>
      <h1 className="mb-6 text-2xl font-semibold">Admin</h1>
      <AdminDashboard />
    </div>
  );
}
