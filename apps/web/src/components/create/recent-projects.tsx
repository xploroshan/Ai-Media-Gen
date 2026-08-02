"use client";

import Link from "next/link";
import useSWR from "swr";

const fetcher = (url: string) =>
  fetch(url).then((r) => {
    if (!r.ok) throw new Error(`failed (${r.status})`);
    return r.json();
  });

type ProjectRow = {
  id: string;
  title: string;
  aspect: string;
  status: string;
  updatedAt: string;
};

export function RecentProjects() {
  const { data, error, isLoading } = useSWR<{ items: ProjectRow[] }>("/api/projects", fetcher);

  if (isLoading) {
    return (
      <div className="flex gap-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-20 w-40 animate-pulse rounded-lg bg-surface-2" />
        ))}
      </div>
    );
  }
  if (error) {
    return (
      <p role="alert" className="text-sm text-danger">
        Couldn&apos;t load your reels — refresh to try again.
      </p>
    );
  }
  if (!data?.items?.length) {
    return <p className="text-sm text-muted">No reels yet — your creations will show up here.</p>;
  }
  return (
    <div className="flex flex-wrap gap-3" data-testid="recent-projects">
      {data.items.slice(0, 8).map((project) => (
        <Link
          key={project.id}
          href={`/projects/${project.id}`}
          className="rounded-lg border border-border bg-surface px-4 py-3 text-sm transition-colors hover:border-primary"
        >
          <p className="font-medium">{project.title}</p>
          <p className="text-xs text-muted">
            {project.aspect} · {project.status} · {new Date(project.updatedAt).toLocaleDateString()}
          </p>
        </Link>
      ))}
    </div>
  );
}
