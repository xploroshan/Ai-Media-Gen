import { ProjectPlayer } from "@/components/project/project-player";

export default async function ProjectPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <ProjectPlayer projectId={projectId} />;
}
