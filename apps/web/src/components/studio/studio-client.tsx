"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import type { GenKind } from "@reelforge/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { computeCost } from "@/lib/gen-cost";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

const TABS: { kind: GenKind; label: string }[] = [
  { kind: "t2i", label: "Text → Image" },
  { kind: "i2v", label: "Image → Video" },
  { kind: "t2v", label: "Text → Video" },
  { kind: "tts", label: "Voiceover" },
  { kind: "music", label: "Music" },
];

type GenModelRow = {
  id: string;
  kind: string;
  tier: string;
  creditPerUnit: number;
  unit: string;
  active: boolean;
};

type GenerationItem = {
  id: string;
  kind: string;
  prompt: string;
  status: string;
  creditCost: number;
  chosenAssetId: string | null;
  bestOf2: boolean;
  error: string | null;
  results: {
    assetId: string;
    kind: string;
    title: string;
    url: string;
    thumbUrl: string | null;
  }[];
};

export function StudioClient() {
  const [tab, setTab] = useState<GenKind>("t2i");
  const [prompt, setPrompt] = useState("");
  const [tier, setTier] = useState("standard");
  const [durationSec, setDurationSec] = useState(5);
  const [aspect, setAspect] = useState<"square" | "portrait" | "landscape">("portrait");
  const [imageAssetId, setImageAssetId] = useState("");
  const [bestOf2, setBestOf2] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: modelData } = useSWR<{ models: GenModelRow[] }>("/api/models", fetcher);
  const { data: credits, mutate: mutateCredits } = useSWR<{ balance: number }>(
    "/api/credits",
    fetcher,
  );
  const { data: gens, mutate: mutateGens } = useSWR<{ items: GenerationItem[] }>(
    "/api/generations",
    fetcher,
    {
      refreshInterval: (latest) =>
        latest?.items?.some((g) => g.status === "queued" || g.status === "running") ? 2500 : 0,
    },
  );
  const { data: media } = useSWR<{
    items: { id: string; kind: string; thumbUrl: string | null; status: string }[];
  }>(tab === "i2v" ? "/api/media?kind=image" : null, fetcher);

  const tiers = useMemo(
    () => (modelData?.models ?? []).filter((m) => m.kind === tab && m.active),
    [modelData, tab],
  );
  const model = tiers.find((m) => m.tier === tier) ?? tiers[0];
  const estimate = model
    ? computeCost(model.creditPerUnit, model.unit, prompt || " ", {
        durationSec,
        bestOf2: tab === "t2v" ? bestOf2 : false,
      })
    : 0;

  async function submit() {
    if (!prompt.trim() || !model) return;
    setBusy(true);
    setError(null);
    const res = await fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: tab,
        tier: model.tier,
        prompt,
        params: {
          ...(tab === "t2i" ? { aspect } : {}),
          ...(tab === "i2v" || tab === "t2v" ? { durationSec } : {}),
          ...(tab === "i2v" ? { imageAssetId } : {}),
          ...(tab === "music" ? { durationSec: 30 } : {}),
          ...(tab === "t2v" && bestOf2 ? { bestOf2: true } : {}),
        },
      }),
    });
    setBusy(false);
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
      setError(body?.error?.message ?? `Failed (${res.status})`);
      return;
    }
    setPrompt("");
    void mutateCredits();
    void mutateGens();
  }

  async function pick(genId: string, assetId: string) {
    await fetch(`/api/generations/${genId}/pick`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assetId }),
    });
    void mutateGens();
  }

  const myGens = (gens?.items ?? []).filter((g) => g.kind === tab);

  return (
    <div className="max-w-3xl">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {TABS.map((t) => (
          <button
            key={t.kind}
            data-testid={`tab-${t.kind}`}
            aria-pressed={tab === t.kind}
            onClick={() => {
              setTab(t.kind);
              setTier("standard");
              setBestOf2(false);
            }}
            className={`rounded-lg border px-3 py-1.5 text-sm ${
              tab === t.kind ? "border-primary bg-surface-2" : "border-border text-muted"
            }`}
          >
            {t.label}
          </button>
        ))}
        <span className="ml-auto text-sm text-muted">
          Credits:{" "}
          <span className="text-foreground" data-testid="credit-balance">
            {credits?.balance ?? "…"}
          </span>
        </span>
      </div>

      <div className="space-y-3 rounded-lg border border-border bg-surface p-4">
        <label className="block text-sm">
          <span className="text-muted">
            {tab === "tts" ? "Text to speak" : tab === "music" ? "Mood / genre" : "Prompt"}
          </span>
          <textarea
            className="mt-1 min-h-20 w-full rounded-lg border border-border bg-surface-2 p-2 text-sm"
            value={prompt}
            data-testid="gen-prompt"
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={
              tab === "music" ? "upbeat travel electronic, 120 bpm" : "a beach at golden hour…"
            }
          />
        </label>

        <div className="flex flex-wrap items-end gap-3 text-sm">
          {tiers.length > 1 ? (
            <label className="block">
              <span className="text-muted">Tier</span>
              <select
                className="mt-1 h-9 rounded-lg border border-border bg-surface-2 px-2"
                value={model?.tier}
                onChange={(e) => setTier(e.target.value)}
                data-testid="gen-tier"
              >
                {tiers.map((m) => (
                  <option key={m.tier} value={m.tier}>
                    {m.tier} ({m.creditPerUnit}/{m.unit})
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          {tab === "t2i" ? (
            <label className="block">
              <span className="text-muted">Aspect</span>
              <select
                className="mt-1 h-9 rounded-lg border border-border bg-surface-2 px-2"
                value={aspect}
                onChange={(e) => setAspect(e.target.value as typeof aspect)}
              >
                <option value="portrait">Portrait 9:16</option>
                <option value="square">Square</option>
                <option value="landscape">Landscape 16:9</option>
              </select>
            </label>
          ) : null}

          {tab === "i2v" || tab === "t2v" ? (
            <label className="block">
              <span className="text-muted">Duration: {durationSec}s</span>
              <input
                type="range"
                min={3}
                max={8}
                value={durationSec}
                onChange={(e) => setDurationSec(Number(e.target.value))}
                className="mt-2 block w-32"
                aria-label="Duration seconds"
              />
            </label>
          ) : null}

          {tab === "t2v" ? (
            <label className="flex items-center gap-1.5 text-muted">
              <input
                type="checkbox"
                checked={bestOf2}
                data-testid="best-of-2"
                onChange={(e) => setBestOf2(e.target.checked)}
              />
              Best of 2 (2× credits, keep your favourite)
            </label>
          ) : null}
        </div>

        {tab === "i2v" ? (
          <div>
            <span className="text-sm text-muted">Source image</span>
            <div className="mt-1 flex gap-2 overflow-x-auto">
              {(media?.items ?? [])
                .filter((m) => m.status === "ready" && m.thumbUrl)
                .slice(0, 12)
                .map((m) => (
                  <button
                    key={m.id}
                    onClick={() => setImageAssetId(m.id)}
                    aria-pressed={imageAssetId === m.id}
                    className={`h-16 w-16 shrink-0 overflow-hidden rounded-md border-2 ${
                      imageAssetId === m.id ? "border-primary" : "border-transparent"
                    }`}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={m.thumbUrl!} alt="" className="h-full w-full object-cover" />
                  </button>
                ))}
            </div>
          </div>
        ) : null}

        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}

        <div className="flex items-center gap-3">
          <Button
            onClick={submit}
            disabled={busy || !prompt.trim() || (tab === "i2v" && !imageAssetId)}
            data-testid="gen-submit"
          >
            {busy ? "Submitting…" : "Generate"}
          </Button>
          <span className="text-sm text-muted" data-testid="credit-estimate">
            Estimated cost: {estimate} credit{estimate === 1 ? "" : "s"}
          </span>
        </div>
      </div>

      <h2 className="mb-2 mt-8 text-sm font-medium text-muted">History</h2>
      {myGens.length === 0 ? (
        <p className="text-sm text-muted">Nothing generated yet.</p>
      ) : (
        <ul className="space-y-4">
          {myGens.map((gen) => (
            <li
              key={gen.id}
              className="rounded-lg border border-border bg-surface p-3"
              data-testid={`generation-${gen.status}`}
            >
              <div className="mb-2 flex items-center gap-2 text-sm">
                <span className="truncate">{gen.prompt}</span>
                <span className="ml-auto shrink-0 text-xs text-muted">
                  {gen.creditCost} cr · <span data-testid="generation-status">{gen.status}</span>
                </span>
              </div>
              {gen.error ? <p className="mb-2 text-xs text-danger">{gen.error}</p> : null}
              <div className="flex flex-wrap gap-3">
                {gen.results.map((result) => (
                  <figure key={result.assetId} className="w-40">
                    {result.kind === "image" ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={result.thumbUrl ?? result.url}
                        alt={result.title}
                        className="aspect-square w-full rounded-md object-cover"
                        data-testid="gen-result-image"
                      />
                    ) : result.kind === "video" ? (
                      <video
                        src={result.url}
                        poster={result.thumbUrl ?? undefined}
                        controls
                        className="w-full rounded-md"
                        data-testid="gen-result-video"
                      />
                    ) : (
                      <audio src={result.url} controls className="w-full" />
                    )}
                    <figcaption className="mt-1 flex items-center gap-1 text-[10px] text-muted">
                      <span className="rounded bg-primary/80 px-1 font-semibold text-white">
                        AI
                      </span>
                      {gen.bestOf2 && gen.results.length > 1 ? (
                        gen.chosenAssetId === result.assetId ? (
                          <span className="text-success">✓ kept</span>
                        ) : (
                          <Button
                            variant="secondary"
                            size="sm"
                            className="h-5 px-1.5 text-[10px]"
                            data-testid={`pick-${result.assetId}`}
                            onClick={() => pick(gen.id, result.assetId)}
                          >
                            Keep this take
                          </Button>
                        )
                      ) : (
                        <Link href="/library" className="underline-offset-2 hover:underline">
                          in library
                        </Link>
                      )}
                    </figcaption>
                  </figure>
                ))}
                {gen.status === "queued" || gen.status === "running" ? (
                  <div className="flex h-24 w-40 animate-pulse items-center justify-center rounded-md bg-surface-2 text-xs text-muted">
                    generating…
                  </div>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
