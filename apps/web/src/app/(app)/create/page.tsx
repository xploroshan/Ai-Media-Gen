import { CreateWizard } from "@/components/create/create-wizard";
import { RecentProjects } from "@/components/create/recent-projects";

export default function CreatePage() {
  return (
    <div>
      <h1 className="mb-6 text-2xl font-semibold">Create a reel</h1>
      <CreateWizard />
      <h2 className="mb-3 mt-10 text-sm font-medium text-muted">Recent reels</h2>
      <RecentProjects />
    </div>
  );
}
