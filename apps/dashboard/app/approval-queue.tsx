"use client";

import { useEffect, useRef, useState } from "react";
import type { StreamEvent } from "../lib/contracts";
import { mandateTask } from "../lib/mandate-tasks";
import { formatMoney } from "../lib/money";
import { subscribe } from "../lib/stream";

type ApprovalRequest = Extract<StreamEvent, { type: "approval_needed" }>;

export default function ApprovalQueue() {
  const [queue, setQueue] = useState<ApprovalRequest[]>([]);
  // Price of each pending decision, from its `decision` event (approval_needed has no price)
  const [prices, setPrices] = useState<Record<string, number | null>>({});
  // Decisions already resolved here or elsewhere; a repeated approval_needed for one is ignored
  const resolved = useRef(new Set<string>());

  useEffect(() => subscribe((events) => {
    const newPrices: Record<string, number | null> = {};
    const added: ApprovalRequest[] = [];
    const removed = new Set<string>();

    for (const e of events) {
      if (e.type === "decision" && e.outcome === "pending") {
        newPrices[e.decision_id] = e.price;
      } else if (e.type === "decision") {
        // approved or denied: a human answered elsewhere, or it timed out
        resolved.current.add(e.decision_id);
        removed.add(e.decision_id);
      } else if (e.type === "approval_needed" && !resolved.current.has(e.decision_id)) {
        added.push(e);
      }
    }

    if (Object.keys(newPrices).length > 0) setPrices((prev) => ({ ...prev, ...newPrices }));
    if (added.length > 0 || removed.size > 0) {
      setQueue((prev) => {
        const ids = new Set(prev.map((r) => r.decision_id));
        const fresh = added.filter((r) => !ids.has(r.decision_id) && !removed.has(r.decision_id));
        return [...prev.filter((r) => !removed.has(r.decision_id)), ...fresh];
      });
    }
  }), []);

  function onResolved(decisionId: string) {
    resolved.current.add(decisionId);
    setQueue((prev) => prev.filter((r) => r.decision_id !== decisionId));
  }

  return (
    <section className="mb-8 max-w-3xl">
      <h2 className="mb-2 text-lg font-semibold">
        Approval queue <span className="text-gray-400">({queue.length})</span>
      </h2>
      {queue.length === 0 && <p className="text-sm text-gray-400">Nothing waiting for a human.</p>}
      <div className="space-y-3">
        {queue.map((r) => (
          <ApprovalItem key={r.decision_id} request={r} price={prices[r.decision_id]} onResolved={onResolved} />
        ))}
      </div>
    </section>
  );
}

function ApprovalItem({ request, price, onResolved }: {
  request: ApprovalRequest;
  price: number | null | undefined;
  onResolved: (decisionId: string) => void;
}) {
  const [note, setNote] = useState("");
  const [issueGrant, setIssueGrant] = useState(false);
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const task = mandateTask(request.mandate_id);

  async function answer(outcome: "approved" | "rejected") {
    if (!note.trim()) return setError("Write a one-line note first.");
    setError("");
    setSending(true);
    const res = await fetch(`/api/approvals/${request.decision_id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // A grant only makes sense for an approval
      body: JSON.stringify({ outcome, note: note.trim(), issue_grant: outcome === "approved" && issueGrant }),
    }).catch(() => null);
    setSending(false);
    if (!res || !res.ok) return setError("Could not send the answer. Try again.");
    onResolved(request.decision_id);
  }

  return (
    <div className="rounded border border-amber-500 p-3 text-sm">
      <div className="flex justify-between">
        <span className="font-mono">{request.decision_id} · {request.mandate_id}</span>
        <span className="text-gray-400">{new Date(request.at).toLocaleTimeString()}</span>
      </div>
      <dl className="mt-2 grid grid-cols-[8rem_1fr] gap-x-2 gap-y-1">
        <dt className="text-gray-400">Mandate task</dt>
        <dd>{task ?? <span className="text-gray-500">Not known (mandate not created on this page)</span>}</dd>
        <dt className="text-gray-400">Price</dt>
        <dd className="font-mono">{price != null ? formatMoney(price) : "—"}</dd>
        <dt className="text-gray-400">Merchant</dt>
        {/* Not in StreamEvent yet; Chunk 2 needs to add it */}
        <dd className="text-gray-500">Not in the stream yet</dd>
        <dt className="text-gray-400">Judge says</dt>
        <dd>{request.explanation ?? <span className="text-gray-500">No explanation</span>}</dd>
      </dl>

      <input className="mt-3 w-full rounded border border-gray-600 bg-transparent px-2 py-1" value={note}
        onChange={(e) => setNote(e.target.value)} placeholder="One-line note (required)" />
      <div className="mt-2 flex items-center gap-3">
        <label>
          <input type="checkbox" checked={issueGrant} onChange={(e) => setIssueGrant(e.target.checked)} />{" "}
          Issue grant
        </label>
        <button type="button" disabled={sending} onClick={() => answer("approved")}
          className="rounded bg-green-700 px-3 py-1 disabled:opacity-50">Approve</button>
        <button type="button" disabled={sending} onClick={() => answer("rejected")}
          className="rounded bg-red-700 px-3 py-1 disabled:opacity-50">Reject</button>
      </div>
      {error && <p className="mt-1 text-red-400">{error}</p>}
    </div>
  );
}
