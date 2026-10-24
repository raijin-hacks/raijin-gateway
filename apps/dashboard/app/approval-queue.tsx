'use client';

import { useEffect, useRef, useState } from 'react';
import type { PendingApproval, StreamEvent } from '@apf/contracts';
import { mandateTask } from '../lib/mandate-tasks';
import { formatMoney } from '../lib/money';
import { subscribe } from '../lib/stream';

// One queue entry. With a gateway, every field comes from GET /approvals; in MOCK mode the
// stream is all we have, so the fields it doesn't carry stay null.
type Item = {
  decision_id: string;
  mandate_id: string;
  task: string | null;
  agent: string | null;
  merchant: string | null;
  endpoint: string | null;
  url: string | null;
  price: number | null;
  reasons: string[];
  explanation: string | null;
  deadline: number | null;
};

function fromGateway(a: PendingApproval): Item {
  return {
    decision_id: a.decision_id,
    mandate_id: a.mandate_id,
    task: a.task,
    agent: `${a.agent.name} (${a.agent.role})`,
    merchant: a.merchant?.name ?? null,
    endpoint: a.endpoint ? `${a.endpoint.method} ${a.endpoint.path}` : null,
    url: a.canonical_url,
    price: a.price,
    reasons: a.reasons,
    explanation: a.judge_explanation,
    deadline: a.deadline,
  };
}

// Each entry is a form, so rendering hundreds of them slows the whole page (D-flood check).
// Show the oldest few; the rest wait their turn. MOCK mode also caps what it keeps.
const MAX_SHOWN = 20;
const MAX_KEPT_IN_MOCK = 200;

export default function ApprovalQueue() {
  const [queue, setQueue] = useState<Item[]>([]);
  // true: the gateway's pending list is the source of truth. false: MOCK mode, build from the stream.
  const fromServer = useRef<boolean | null>(null);
  // MOCK mode only: price of each pending decision, from its `decision` event
  const prices = useRef<Record<string, number | null>>({});
  // MOCK mode only: decisions already resolved; a repeated approval_needed for one is ignored
  const resolved = useRef(new Set<string>());
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let stopped = false;

    async function load() {
      const res = await fetch('/api/approvals').catch(() => null);
      if (stopped || !res || !res.ok) return;
      const list: PendingApproval[] | null = await res.json();
      fromServer.current = list !== null; // the route answers null in MOCK mode
      if (list) setQueue(list.map(fromGateway));
    }

    // Several events usually arrive together; reload once after they settle.
    function reloadSoon() {
      if (reloadTimer.current) clearTimeout(reloadTimer.current);
      reloadTimer.current = setTimeout(load, 300);
    }

    // MOCK mode: approval_needed adds an entry, an approved or denied decision removes it.
    function addFromStream(events: StreamEvent[]) {
      const added: Item[] = [];
      const removed = new Set<string>();
      for (const e of events) {
        if (e.type === 'decision' && e.outcome === 'pending') {
          prices.current[e.decision_id] = e.price;
        } else if (e.type === 'decision') {
          resolved.current.add(e.decision_id);
          removed.add(e.decision_id);
        } else if (e.type === 'approval_needed' && !resolved.current.has(e.decision_id)) {
          added.push({
            decision_id: e.decision_id,
            mandate_id: e.mandate_id,
            task: mandateTask(e.mandate_id) ?? null,
            agent: null,
            merchant: null,
            endpoint: null,
            url: null,
            price: prices.current[e.decision_id] ?? null,
            reasons: [],
            explanation: e.explanation,
            deadline: null,
          });
        }
      }
      if (added.length === 0 && removed.size === 0) return;
      setQueue((prev) => {
        const ids = new Set(prev.map((r) => r.decision_id));
        const fresh = added.filter((r) => !ids.has(r.decision_id) && !removed.has(r.decision_id));
        return [...prev.filter((r) => !removed.has(r.decision_id)), ...fresh].slice(
          0,
          MAX_KEPT_IN_MOCK,
        );
      });
    }

    load();
    const unsubscribe = subscribe((events) => {
      if (fromServer.current) {
        if (events.some((e) => e.type === 'approval_needed' || e.type === 'decision')) reloadSoon();
        return;
      }
      addFromStream(events);
    });

    return () => {
      stopped = true;
      unsubscribe();
      if (reloadTimer.current) clearTimeout(reloadTimer.current);
    };
  }, []);

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
        {queue.slice(0, MAX_SHOWN).map((item) => (
          <ApprovalItem key={item.decision_id} item={item} onResolved={onResolved} />
        ))}
      </div>
      {queue.length > MAX_SHOWN && (
        <p className="mt-2 text-sm text-gray-400">
          {queue.length - MAX_SHOWN} more waiting. They appear here as you answer these.
        </p>
      )}
    </section>
  );
}

function ApprovalItem({
  item,
  onResolved,
}: {
  item: Item;
  onResolved: (decisionId: string) => void;
}) {
  const [note, setNote] = useState('');
  const [issueGrant, setIssueGrant] = useState(false);
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);

  async function answer(outcome: 'approved' | 'rejected') {
    if (!note.trim()) return setError('Write a one-line note first.');
    setError('');
    setSending(true);
    const res = await fetch(`/api/approvals/${item.decision_id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // A grant only makes sense for an approval
      body: JSON.stringify({
        outcome,
        note: note.trim(),
        issue_grant: outcome === 'approved' && issueGrant,
      }),
    }).catch(() => null);
    setSending(false);
    if (!res || !res.ok) return setError('Could not send the answer. Try again.');
    onResolved(item.decision_id);
  }

  const unknown = <span className="text-gray-500">Not known</span>;

  return (
    <div className="rounded border border-amber-500 p-3 text-sm">
      <div className="flex flex-wrap justify-between gap-x-3">
        <span className="font-mono break-all">
          {item.decision_id} · {item.mandate_id}
        </span>
        {item.deadline !== null && (
          <span className="text-gray-400">
            Auto-rejects at {new Date(item.deadline).toLocaleTimeString()}
          </span>
        )}
      </div>
      <dl className="mt-2 grid grid-cols-[8rem_1fr] gap-x-2 gap-y-1">
        <dt className="text-gray-400">Mandate task</dt>
        <dd>{item.task ?? unknown}</dd>
        <dt className="text-gray-400">Agent</dt>
        <dd>{item.agent ?? unknown}</dd>
        <dt className="text-gray-400">Merchant</dt>
        <dd>
          {item.merchant ?? unknown}
          {item.endpoint && <span className="ml-2 font-mono text-gray-400">{item.endpoint}</span>}
        </dd>
        {item.url && (
          <>
            <dt className="text-gray-400">URL</dt>
            <dd className="font-mono break-all">{item.url}</dd>
          </>
        )}
        <dt className="text-gray-400">Price</dt>
        <dd className="font-mono">{item.price !== null ? formatMoney(item.price) : '—'}</dd>
        {item.reasons.length > 0 && (
          <>
            <dt className="text-gray-400">Why held</dt>
            <dd className="flex flex-wrap gap-1">
              {item.reasons.map((r) => (
                <span key={r} className="rounded bg-gray-700 px-1.5 text-xs">
                  {r}
                </span>
              ))}
            </dd>
          </>
        )}
        <dt className="text-gray-400">Judge says</dt>
        <dd>{item.explanation ?? <span className="text-gray-500">No explanation</span>}</dd>
      </dl>

      <input
        className="mt-3 w-full rounded border border-gray-600 bg-transparent px-2 py-1"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="One-line note (required)"
      />
      <div className="mt-2 flex items-center gap-3">
        <label>
          <input
            type="checkbox"
            checked={issueGrant}
            onChange={(e) => setIssueGrant(e.target.checked)}
          />{' '}
          Issue grant
        </label>
        <button
          type="button"
          disabled={sending}
          onClick={() => answer('approved')}
          className="rounded bg-green-700 px-3 py-1 disabled:opacity-50"
        >
          Approve
        </button>
        <button
          type="button"
          disabled={sending}
          onClick={() => answer('rejected')}
          className="rounded bg-red-700 px-3 py-1 disabled:opacity-50"
        >
          Reject
        </button>
      </div>
      {error && <p className="mt-1 text-red-400">{error}</p>}
    </div>
  );
}
