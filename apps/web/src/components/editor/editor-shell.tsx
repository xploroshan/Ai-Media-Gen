"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import { EditSpecSchema } from "@reelforge/shared";
import { Button } from "@/components/ui/button";
import { useEditorStore } from "@/lib/editor/store";
import { CaptionsPanel } from "./captions-panel";
import { PreviewCanvas, type AssetMap } from "./preview-canvas";
import { PropertiesPanel } from "./properties-panel";
import { Timeline } from "./timeline";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

const AUTOSAVE_DEBOUNCE_MS = 800; // SPEC §7

type ProjectData = {
  id: string;
  title: string;
  status: string;
  editSpec: unknown;
  previewUrl: string | null;
  activeJob: { id: string; type: string; progress: number | null } | null;
};

export function EditorShell({ projectId }: { projectId: string }) {
  const { data: project, mutate } = useSWR<ProjectData>(`/api/projects/${projectId}`, fetcher, {
    refreshInterval: (latest) => (latest?.activeJob ? 2000 : 0),
    revalidateOnFocus: false,
  });
  const { data: assetData } = useSWR<{ assets: AssetMap }>(
    `/api/projects/${projectId}/assets`,
    fetcher,
    { revalidateOnFocus: false },
  );

  const spec = useEditorStore((s) => s.spec);
  const dirty = useEditorStore((s) => s.dirty);
  const load = useEditorStore((s) => s.load);
  const markSaved = useEditorStore((s) => s.markSaved);
  const playing = useEditorStore((s) => s.playing);
  const setPlaying = useEditorStore((s) => s.setPlaying);
  const setPlayhead = useEditorStore((s) => s.setPlayhead);
  const splitAtPlayhead = useEditorStore((s) => s.splitAtPlayhead);
  const deleteSelected = useEditorStore((s) => s.deleteSelected);
  const addText = useEditorStore((s) => s.addText);
  const undo = useEditorStore((s) => s.undo);
  const redo = useEditorStore((s) => s.redo);

  const loadedFor = useRef<string | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [rendering, setRendering] = useState(false);

  // load once per project
  useEffect(() => {
    if (!project || loadedFor.current === projectId) return;
    const parsed = EditSpecSchema.safeParse(project.editSpec);
    if (parsed.success) {
      load(parsed.data);
      loadedFor.current = projectId;
    }
  }, [project, projectId, load]);

  const save = useCallback(
    async (render: boolean) => {
      const current = useEditorStore.getState().spec;
      if (!current) return false;
      setSaveState("saving");
      const res = await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ editSpec: current, render }),
      });
      if (!res.ok) {
        setSaveState("error");
        return false;
      }
      markSaved();
      setSaveState("saved");
      return true;
    },
    [projectId, markSaved],
  );

  // autosave: debounce 800 ms after last edit
  useEffect(() => {
    if (!dirty) return;
    const timer = setTimeout(() => void save(false), AUTOSAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [dirty, spec, save]);

  // keyboard shortcuts (SPEC §7)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.tagName === "SELECT"
      )
        return;
      if (e.code === "Space") {
        e.preventDefault();
        setPlaying(!useEditorStore.getState().playing);
      } else if (e.key === "ArrowLeft") {
        setPlayhead(useEditorStore.getState().playhead - 1 / 30);
      } else if (e.key === "ArrowRight") {
        setPlayhead(useEditorStore.getState().playhead + 1 / 30);
      } else if (e.key === "s" || e.key === "S") {
        splitAtPlayhead();
      } else if (e.key === "Delete" || e.key === "Backspace") {
        deleteSelected();
      } else if ((e.metaKey || e.ctrlKey) && e.key === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if ((e.metaKey || e.ctrlKey) && (e.key === "y" || (e.key === "z" && e.shiftKey))) {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setPlaying, setPlayhead, splitAtPlayhead, deleteSelected, undo, redo]);

  async function previewRender() {
    setRendering(true);
    const ok = await save(true);
    if (ok) await mutate();
    setRendering(false);
  }

  if (!project || !spec) {
    return <div className="h-96 animate-pulse rounded-xl bg-surface-2" />;
  }

  const assets = assetData?.assets ?? {};
  const busy = Boolean(project.activeJob) || rendering;

  return (
    <div className="flex h-full flex-col gap-4">
      {/* top bar */}
      <div className="flex flex-wrap items-center gap-3">
        <Link href={`/projects/${projectId}`} className="text-sm text-muted hover:text-foreground">
          ← Back
        </Link>
        <h1 className="truncate text-lg font-semibold">{project.title}</h1>
        <span className="text-xs text-muted" data-testid="save-state">
          {saveState === "saving"
            ? "Saving…"
            : saveState === "error"
              ? "Save failed"
              : dirty
                ? "Unsaved changes"
                : saveState === "saved"
                  ? "Saved"
                  : ""}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => addText()} data-testid="add-text">
            + Text
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setPlaying(!playing)}>
            {playing ? "Pause" : "Play"}
          </Button>
          <Button size="sm" onClick={previewRender} disabled={busy} data-testid="preview-render">
            {busy ? "Rendering…" : "Preview render"}
          </Button>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[1fr_auto]">
        <div className="min-w-0 space-y-4">
          <PreviewCanvas assets={assets} />
          <Timeline assets={assets} />
          <CaptionsPanel assets={assets} />
          {project.previewUrl ? (
            <details className="rounded-lg border border-border bg-surface p-3 text-sm">
              <summary className="cursor-pointer text-muted">Server preview render (truth)</summary>
              <video
                src={project.previewUrl}
                controls
                className="mt-2 max-h-80 rounded"
                data-testid="server-preview"
              />
            </details>
          ) : null}
        </div>
        <PropertiesPanel assets={assets} />
      </div>

      <p className="text-xs text-muted">
        Space play/pause · ←/→ step · S split · Del delete · desktop-first (mobile: view &amp; basic
        edits)
      </p>
    </div>
  );
}
