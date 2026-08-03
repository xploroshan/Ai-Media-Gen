import { EditorShell } from "@/components/editor/editor-shell";

export default async function EditorPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <EditorShell projectId={projectId} />;
}
