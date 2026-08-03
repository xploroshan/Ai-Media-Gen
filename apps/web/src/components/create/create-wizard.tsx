"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import useSWR from "swr";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

type Vibe = { id: string; name: string; sortOrder: number };
type Preset = { id: string; name: string; aspect: string; maxSec: number; recSec: number };
type EventItem = { id: string; title: string; assetCount: number; coverUrl: string | null };
type MediaItem = { id: string; filename: string; status: string; thumbUrl: string | null };

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export function CreateWizard() {
  const router = useRouter();
  const { data: meta } = useSWR<{ vibes: Vibe[]; presets: Preset[] }>("/api/meta", fetcher);
  const { data: events } = useSWR<{ items: EventItem[] }>("/api/events", fetcher);
  const { data: media } = useSWR<{ items: MediaItem[] }>("/api/media", fetcher);

  const [eventId, setEventId] = useState<string | null>(null);
  const [assetIds, setAssetIds] = useState<string[]>([]);
  const [vibeId, setVibeId] = useState<string | null>(null);
  const [presetId, setPresetId] = useState<string>("reel");
  const [targetSec, setTargetSec] = useState<number>(20);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const preset = useMemo(() => meta?.presets.find((p) => p.id === presetId), [meta, presetId]);
  const readyMedia = (media?.items ?? []).filter((m) => m.status === "ready" && m.thumbUrl);
  const selectionOk = eventId !== null || assetIds.length >= 2;

  function toggleAsset(id: string) {
    setEventId(null);
    setAssetIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  async function create() {
    if (!vibeId || !selectionOk) return;
    setBusy(true);
    setError(null);
    const res = await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...(eventId ? { eventId } : { assetIds }),
        vibeId,
        presetId,
        targetSec,
      }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      setError(body?.error?.message ?? `Failed (${res.status})`);
      setBusy(false);
      return;
    }
    const { projectId } = (await res.json()) as { projectId: string };
    router.push(`/projects/${projectId}`);
  }

  return (
    <div className="max-w-3xl space-y-8">
      <section aria-label="Pick media">
        <h2 className="mb-2 text-sm font-medium text-muted">1 · Pick an event or select media</h2>
        {events?.items?.length ? (
          <div className="mb-3 flex flex-wrap gap-2">
            {events.items.map((event) => (
              <button
                key={event.id}
                data-testid="wizard-event"
                onClick={() => {
                  setAssetIds([]);
                  setEventId(eventId === event.id ? null : event.id);
                }}
                className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm ${
                  eventId === event.id ? "border-primary bg-surface-2" : "border-border"
                }`}
              >
                {event.coverUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={event.coverUrl} alt="" className="h-8 w-8 rounded object-cover" />
                ) : null}
                {event.title} ({event.assetCount})
              </button>
            ))}
          </div>
        ) : null}
        {readyMedia.length ? (
          <div className="grid grid-cols-4 gap-2 sm:grid-cols-6 md:grid-cols-8">
            {readyMedia.map((m) => (
              <button
                key={m.id}
                onClick={() => toggleAsset(m.id)}
                aria-pressed={assetIds.includes(m.id)}
                className={`relative aspect-square overflow-hidden rounded-md border-2 ${
                  assetIds.includes(m.id) ? "border-primary" : "border-transparent"
                }`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={m.thumbUrl!} alt={m.filename} className="h-full w-full object-cover" />
              </button>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted">
            No ready media yet — upload some in the Library first.
          </p>
        )}
      </section>

      <section aria-label="Pick vibe">
        <h2 className="mb-2 text-sm font-medium text-muted">2 · Choose a vibe</h2>
        <div className="grid gap-3 sm:grid-cols-3">
          {(meta?.vibes ?? []).map((vibe) => (
            <Card
              key={vibe.id}
              role="button"
              tabIndex={0}
              data-testid={`vibe-${vibe.id}`}
              aria-pressed={vibeId === vibe.id}
              onClick={() => setVibeId(vibe.id)}
              onKeyDown={(e) => e.key === "Enter" && setVibeId(vibe.id)}
              className={`cursor-pointer p-4 transition-colors ${
                vibeId === vibe.id ? "border-primary" : "hover:border-muted"
              }`}
            >
              <p className="font-medium">{vibe.name}</p>
            </Card>
          ))}
        </div>
      </section>

      <section aria-label="Pick format">
        <h2 className="mb-2 text-sm font-medium text-muted">3 · Format &amp; length</h2>
        <div className="mb-3 flex flex-wrap gap-2">
          {(meta?.presets ?? []).map((p) => (
            <button
              key={p.id}
              data-testid={`preset-${p.id}`}
              aria-pressed={presetId === p.id}
              onClick={() => {
                setPresetId(p.id);
                setTargetSec(Math.min(p.recSec, p.maxSec));
              }}
              className={`rounded-lg border px-3 py-2 text-sm ${
                presetId === p.id ? "border-primary bg-surface-2" : "border-border"
              }`}
            >
              {p.name} <span className="text-muted">({p.aspect})</span>
            </button>
          ))}
        </div>
        {preset ? (
          <label className="block text-sm">
            Target length: <span className="font-medium">{targetSec}s</span>
            <input
              type="range"
              min={10}
              max={Math.min(preset.maxSec, 90)}
              step={5}
              value={targetSec}
              onChange={(e) => setTargetSec(Number(e.target.value))}
              className="mt-1 w-full accent-[--color-primary]"
              aria-label="Target length in seconds"
            />
          </label>
        ) : null}
      </section>

      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
      <Button
        size="lg"
        data-testid="create-reel"
        disabled={!vibeId || !selectionOk || busy}
        onClick={create}
      >
        {busy ? "Creating…" : "Create my reel"}
      </Button>
    </div>
  );
}
