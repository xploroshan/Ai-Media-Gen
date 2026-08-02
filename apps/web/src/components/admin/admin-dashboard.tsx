"use client";

import { useState } from "react";
import useSWR from "swr";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

type JobRow = {
  id: string;
  type: string;
  status: string;
  attempts: number;
  error: string | null;
  createdAt: string;
};
type ModelRow = {
  id: string;
  kind: string;
  tier: string;
  providerId: string;
  modelSlug: string;
  creditPerUnit: number;
  unit: string;
  active: boolean;
};
type UserRow = {
  id: string;
  email: string;
  plan: string;
  creditsBalance: number;
  isAdmin: boolean;
};

export function AdminDashboard() {
  const [tab, setTab] = useState<"jobs" | "models" | "users" | "flags">("jobs");
  return (
    <div>
      <div className="mb-4 flex gap-2">
        {(["jobs", "models", "users", "flags"] as const).map((t) => (
          <button
            key={t}
            data-testid={`admin-tab-${t}`}
            aria-pressed={tab === t}
            onClick={() => setTab(t)}
            className={`rounded-lg border px-3 py-1.5 text-sm capitalize ${
              tab === t ? "border-primary bg-surface-2" : "border-border text-muted"
            }`}
          >
            {t}
          </button>
        ))}
      </div>
      {tab === "jobs" ? <JobsPanel /> : null}
      {tab === "models" ? <ModelsPanel /> : null}
      {tab === "users" ? <UsersPanel /> : null}
      {tab === "flags" ? <FlagsPanel /> : null}
    </div>
  );
}

function JobsPanel() {
  const [status, setStatus] = useState("");
  const { data } = useSWR<{ counts: Record<string, number>; jobs: JobRow[] }>(
    `/api/admin/jobs${status ? `?status=${status}` : ""}`,
    fetcher,
    { refreshInterval: 5000 },
  );
  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-2 text-xs">
        {Object.entries(data?.counts ?? {}).map(([s, n]) => (
          <button
            key={s}
            onClick={() => setStatus(status === s ? "" : s)}
            className={`rounded-full border px-2 py-0.5 ${
              status === s ? "border-primary" : "border-border text-muted"
            }`}
          >
            {s}: {n}
          </button>
        ))}
      </div>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-left text-xs">
          <thead className="bg-surface-2 text-muted">
            <tr>
              <th className="p-2">type</th>
              <th className="p-2">status</th>
              <th className="p-2">attempts</th>
              <th className="p-2">created</th>
              <th className="p-2">error</th>
            </tr>
          </thead>
          <tbody>
            {(data?.jobs ?? []).map((job) => (
              <tr key={job.id} className="border-t border-border">
                <td className="p-2">{job.type}</td>
                <td className="p-2">{job.status}</td>
                <td className="p-2">{job.attempts}</td>
                <td className="p-2">{new Date(job.createdAt).toLocaleTimeString()}</td>
                <td className="max-w-64 truncate p-2 text-danger">{job.error}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ModelsPanel() {
  const { data, mutate } = useSWR<{ models: ModelRow[] }>("/api/admin/models", fetcher);
  const [edits, setEdits] = useState<Record<string, Partial<ModelRow>>>({});

  async function save(model: ModelRow) {
    const patch = edits[model.id] ?? {};
    await fetch("/api/admin/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...model, ...patch }),
    });
    setEdits((e) => ({ ...e, [model.id]: {} }));
    void mutate();
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-left text-xs" data-testid="models-table">
        <thead className="bg-surface-2 text-muted">
          <tr>
            <th className="p-2">kind/tier</th>
            <th className="p-2">slug (fal — verify against live catalog)</th>
            <th className="p-2">credits</th>
            <th className="p-2">unit</th>
            <th className="p-2">active</th>
            <th className="p-2" />
          </tr>
        </thead>
        <tbody>
          {(data?.models ?? []).map((model) => (
            <tr key={model.id} className="border-t border-border">
              <td className="p-2">
                {model.kind}/{model.tier}
              </td>
              <td className="p-2">
                <Input
                  className="h-7 min-w-64 text-xs"
                  defaultValue={model.modelSlug}
                  onChange={(e) =>
                    setEdits((prev) => ({
                      ...prev,
                      [model.id]: { ...prev[model.id], modelSlug: e.target.value },
                    }))
                  }
                />
              </td>
              <td className="p-2">
                <Input
                  type="number"
                  className="h-7 w-16 text-xs"
                  defaultValue={model.creditPerUnit}
                  onChange={(e) =>
                    setEdits((prev) => ({
                      ...prev,
                      [model.id]: { ...prev[model.id], creditPerUnit: Number(e.target.value) },
                    }))
                  }
                />
              </td>
              <td className="p-2">{model.unit}</td>
              <td className="p-2">
                <input
                  type="checkbox"
                  defaultChecked={model.active}
                  onChange={(e) =>
                    setEdits((prev) => ({
                      ...prev,
                      [model.id]: { ...prev[model.id], active: e.target.checked },
                    }))
                  }
                />
              </td>
              <td className="p-2">
                <Button size="sm" variant="secondary" onClick={() => save(model)}>
                  Save
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function UsersPanel() {
  const [query, setQuery] = useState("");
  const { data, mutate } = useSWR<{ users: UserRow[] }>(
    `/api/admin/users?query=${encodeURIComponent(query)}`,
    fetcher,
  );
  const [delta, setDelta] = useState<Record<string, string>>({});

  async function update(userId: string, body: object) {
    await fetch("/api/admin/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, ...body }),
    });
    void mutate();
  }

  return (
    <div>
      <Input
        placeholder="Search by email…"
        className="mb-3 w-64"
        value={query}
        data-testid="user-search"
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-left text-xs" data-testid="users-table">
          <thead className="bg-surface-2 text-muted">
            <tr>
              <th className="p-2">email</th>
              <th className="p-2">plan</th>
              <th className="p-2">credits</th>
              <th className="p-2">adjust</th>
            </tr>
          </thead>
          <tbody>
            {(data?.users ?? []).map((user) => (
              <tr
                key={user.id}
                className="border-t border-border"
                data-testid={`user-${user.email}`}
              >
                <td className="p-2">{user.email}</td>
                <td className="p-2">
                  <select
                    className="rounded border border-border bg-surface px-1 py-0.5"
                    value={user.plan}
                    data-testid="plan-select"
                    onChange={(e) => update(user.id, { plan: e.target.value })}
                  >
                    <option value="free">free</option>
                    <option value="creator">creator</option>
                    <option value="business">business</option>
                  </select>
                </td>
                <td className="p-2" data-testid="user-credits">
                  {user.creditsBalance}
                </td>
                <td className="flex items-center gap-1 p-2">
                  <Input
                    type="number"
                    className="h-7 w-20 text-xs"
                    placeholder="+/-"
                    value={delta[user.id] ?? ""}
                    data-testid="credit-delta"
                    onChange={(e) => setDelta((d) => ({ ...d, [user.id]: e.target.value }))}
                  />
                  <Button
                    size="sm"
                    variant="secondary"
                    data-testid="apply-credit"
                    onClick={() => {
                      const value = Number(delta[user.id]);
                      if (Number.isInteger(value) && value !== 0) {
                        void update(user.id, { creditDelta: value });
                        setDelta((d) => ({ ...d, [user.id]: "" }));
                      }
                    }}
                  >
                    Apply
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function FlagsPanel() {
  const { data, mutate } = useSWR<{ flags: { key: string; value: unknown }[] }>(
    "/api/admin/flags",
    fetcher,
  );
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");

  return (
    <div className="max-w-md space-y-3">
      <ul className="space-y-1 text-sm">
        {(data?.flags ?? []).map((flag) => (
          <li key={flag.key} className="flex justify-between rounded border border-border p-2">
            <span>{flag.key}</span>
            <code className="text-xs text-muted">{JSON.stringify(flag.value)}</code>
          </li>
        ))}
        {data?.flags?.length === 0 ? <p className="text-xs text-muted">No flags set.</p> : null}
      </ul>
      <div className="flex gap-2">
        <Input placeholder="key" value={key} onChange={(e) => setKey(e.target.value)} />
        <Input
          placeholder='value (JSON, e.g. true or "x")'
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <Button
          variant="secondary"
          onClick={async () => {
            let parsed: unknown = value;
            try {
              parsed = JSON.parse(value);
            } catch {
              /* keep string */
            }
            await fetch("/api/admin/flags", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ key, value: parsed }),
            });
            setKey("");
            setValue("");
            void mutate();
          }}
        >
          Set
        </Button>
      </div>
    </div>
  );
}
