"use client";

import useSWR from "swr";

const fetcher = (url: string) =>
  fetch(url).then((r) => {
    if (!r.ok) throw new Error(`failed (${r.status})`);
    return r.json();
  });

type Ledger = {
  balance: number;
  plan: string;
  ledger: { id: string; delta: number; reason: string; balanceAfter: number; createdAt: string }[];
};

export function CreditsLedger() {
  const { data, error, isLoading } = useSWR<Ledger>("/api/credits", fetcher);

  if (isLoading) return <div className="h-40 animate-pulse rounded-lg bg-surface-2" />;
  if (error) {
    return (
      <p role="alert" className="text-sm text-danger">
        Couldn&apos;t load your credit history — refresh to try again.
      </p>
    );
  }
  if (!data) return null;

  return (
    <section aria-label="Credit history">
      <h2 className="mb-2 text-sm font-medium text-muted">
        Credit history — balance {data.balance}
      </h2>
      {data.ledger.length === 0 ? (
        <p className="text-sm text-muted">No credit activity yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-left text-xs" data-testid="ledger-table">
            <thead className="bg-surface-2 text-muted">
              <tr>
                <th className="p-2">when</th>
                <th className="p-2">reason</th>
                <th className="p-2 text-right">delta</th>
                <th className="p-2 text-right">balance</th>
              </tr>
            </thead>
            <tbody>
              {data.ledger.map((row) => (
                <tr key={row.id} className="border-t border-border">
                  <td className="p-2">{new Date(row.createdAt).toLocaleString()}</td>
                  <td className="p-2">{row.reason.replace(/_/g, " ")}</td>
                  <td
                    className={`p-2 text-right ${row.delta < 0 ? "text-danger" : "text-success"}`}
                  >
                    {row.delta > 0 ? `+${row.delta}` : row.delta}
                  </td>
                  <td className="p-2 text-right">{row.balanceAfter}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
