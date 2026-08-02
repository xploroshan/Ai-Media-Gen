"use client";

import { useMemo, useRef, useState } from "react";
import useSWR from "swr";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { uploadFile } from "@/lib/upload";
import { AssetDrawer } from "./asset-drawer";

export type LibraryItem = {
  id: string;
  kind: string;
  status: string;
  filename: string;
  thumbUrl: string | null;
  qualityScore: number | null;
  tags: { label: string; score: number }[];
  durationSec: number | null;
  synthetic: boolean;
  eventId: string | null;
};

type EventItem = {
  id: string;
  title: string;
  assetCount: number;
  coverUrl: string | null;
};

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export function LibraryClient() {
  const [query, setQuery] = useState("");
  const [eventId, setEventId] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [uploading, setUploading] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const mediaUrl = useMemo(() => {
    const params = new URLSearchParams();
    if (query) params.set("query", query);
    if (eventId) params.set("eventId", eventId);
    return `/api/media?${params}`;
  }, [query, eventId]);

  const { data, mutate, isLoading } = useSWR<{ items: LibraryItem[] }>(mediaUrl, fetcher, {
    refreshInterval: (latest) =>
      latest?.items?.some((i) => i.status === "analyzing" || i.status === "uploading") ? 2000 : 0,
  });
  const { data: events, mutate: mutateEvents } = useSWR<{ items: EventItem[] }>(
    "/api/events",
    fetcher,
    { refreshInterval: 10000 },
  );

  async function onFiles(files: FileList | null) {
    if (!files?.length) return;
    setUploadError(null);
    setUploading(files.length);
    try {
      for (const file of Array.from(files)) {
        await uploadFile(file);
        setUploading((n) => n - 1);
        void mutate();
      }
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(0);
      void mutate();
      void mutateEvents();
    }
  }

  const items = data?.items ?? [];
  const analyzing = items.filter((i) => i.status === "analyzing").length;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">Library</h1>
        <div className="ml-auto flex items-center gap-2">
          <Input
            aria-label="Search media"
            placeholder="Search tags or filenames…"
            className="w-56"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            accept="image/*,video/*,audio/*"
            data-testid="upload-input"
            onChange={(e) => onFiles(e.target.files)}
          />
          <Button onClick={() => fileInput.current?.click()} disabled={uploading > 0}>
            {uploading > 0 ? `Uploading ${uploading}…` : "Upload"}
          </Button>
        </div>
      </div>

      {uploadError ? (
        <p role="alert" className="mb-3 text-sm text-danger">
          {uploadError}
        </p>
      ) : null}
      {analyzing > 0 ? (
        <p className="mb-3 text-sm text-muted" data-testid="analyzing-banner">
          Analyzing {analyzing} file{analyzing > 1 ? "s" : ""}…
        </p>
      ) : null}

      {events?.items?.length ? (
        <section aria-label="Events" className="mb-6">
          <h2 className="mb-2 text-sm font-medium text-muted">Events</h2>
          <div className="flex gap-3 overflow-x-auto pb-1">
            <button
              className={`rounded-lg border px-3 py-2 text-sm ${eventId === null ? "border-primary text-foreground" : "border-border text-muted"}`}
              onClick={() => setEventId(null)}
            >
              All media
            </button>
            {events.items.map((event) => (
              <button
                key={event.id}
                data-testid="event-card"
                className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm ${eventId === event.id ? "border-primary" : "border-border"}`}
                onClick={() => setEventId(eventId === event.id ? null : event.id)}
              >
                {event.coverUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={event.coverUrl} alt="" className="h-8 w-8 rounded object-cover" />
                ) : null}
                <span>{event.title}</span>
                <span className="text-muted">({event.assetCount})</span>
              </button>
            ))}
          </div>
        </section>
      ) : null}

      {isLoading ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
          {Array.from({ length: 12 }).map((_, i) => (
            <div key={i} className="aspect-square animate-pulse rounded-lg bg-surface-2" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <p className="text-sm text-muted" data-testid="library-empty">
          {query || eventId
            ? "Nothing matches this search."
            : "Your media library is empty. Upload photos and videos to get started."}
        </p>
      ) : (
        <div
          className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6"
          data-testid="media-grid"
        >
          {items.map((item) => (
            <button
              key={item.id}
              data-testid={`media-item-${item.status}`}
              className="group relative aspect-square overflow-hidden rounded-lg border border-border bg-surface-2 text-left focus-visible:ring-2 focus-visible:ring-primary"
              onClick={() => setSelected(item.id)}
              aria-label={item.filename}
            >
              {item.thumbUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={item.thumbUrl}
                  alt={item.filename}
                  className="h-full w-full object-cover transition-transform group-hover:scale-105"
                  data-testid="media-thumb"
                />
              ) : (
                <div className="flex h-full items-center justify-center text-xs text-muted">
                  {item.status === "analyzing" || item.status === "uploading" ? (
                    <span className="animate-pulse">{item.status}…</span>
                  ) : (
                    item.kind
                  )}
                </div>
              )}
              {item.kind === "video" && item.durationSec ? (
                <span className="absolute bottom-1 right-1 rounded bg-black/70 px-1 text-[10px]">
                  {Math.round(item.durationSec)}s
                </span>
              ) : null}
              {item.synthetic ? (
                <span className="absolute left-1 top-1 rounded bg-primary/90 px-1 text-[10px] font-semibold">
                  AI
                </span>
              ) : null}
              {item.status === "failed" ? (
                <span className="absolute inset-x-0 bottom-0 bg-danger/80 px-1 py-0.5 text-center text-[10px]">
                  analysis failed
                </span>
              ) : null}
            </button>
          ))}
        </div>
      )}

      {selected ? <AssetDrawer assetId={selected} onClose={() => setSelected(null)} /> : null}
    </div>
  );
}
