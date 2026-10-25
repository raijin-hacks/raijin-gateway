'use client';

import { useEffect, useState } from 'react';
import type { AgentSummary } from '@apf/contracts';
import { subscribe } from '../lib/stream';

export default function AgentRestrictions() {
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let stopped = false;
    let loading = false;
    let again = false;
    async function load() {
      if (loading) {
        again = true;
        return;
      }
      loading = true;
      try {
        const res = await fetch('/api/agents', { cache: 'no-store' });
        if (!res.ok) throw new Error('Could not load agent restrictions.');
        const list: AgentSummary[] = await res.json();
        if (!stopped) {
          setAgents(list);
          setError('');
        }
      } catch {
        if (!stopped) setError('Could not load agent restrictions.');
      } finally {
        loading = false;
        if (again && !stopped) {
          again = false;
          void load();
        }
      }
    }
    void load();
    const unsubscribe = subscribe((events) => {
      if (events.some((e) => e.type === 'agent_incident' || e.type === 'agent_restored'))
        void load();
    });
    // Reload after missed SSE messages/reconnects too; the database is authoritative.
    const timer = setInterval(load, 5000);
    return () => {
      stopped = true;
      unsubscribe();
      clearInterval(timer);
    };
  }, [revision]);
  return (
    <section className="my-6 rounded border border-gray-700 p-4">
      <h2 className="text-lg font-semibold">Agent restrictions</h2>
      <p className="mb-3 text-sm text-gray-400">
        Incidents add review or suspend purchases. Only an operator restoration loosens
        restrictions.
      </p>
      {error && (
        <p role="alert" className="text-red-400">
          {error}
        </p>
      )}
      <div className="grid gap-3 md:grid-cols-3">
        {agents.map((agent) => (
          <AgentCard key={agent.id} agent={agent} restored={() => setRevision((r) => r + 1)} />
        ))}
      </div>
    </section>
  );
}

function AgentCard({ agent, restored }: { agent: AgentSummary; restored: () => void }) {
  const [target, setTarget] = useState<'normal' | 'review_required'>('normal');
  const [reason, setReason] = useState('');
  const [operator, setOperator] = useState('');
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState('');
  const color =
    agent.restriction === 'normal'
      ? 'text-green-400'
      : agent.restriction === 'suspended'
        ? 'text-red-400'
        : 'text-amber-300';
  return (
    <article className="rounded bg-gray-900 p-3 text-sm">
      <h3 className="font-semibold">{agent.name}</h3>
      <p className={color}>{agent.restriction}</p>
      <p className="text-gray-400">
        {agent.role} · score {agent.trust}
      </p>
      <ul className="my-2 space-y-1">
        {agent.recent_incidents.slice(0, 3).map((i) => (
          <li key={i.decision_id}>
            <span className="text-amber-200">{i.cause}</span> → {i.restriction}
            <div className="break-all text-xs text-gray-500">
              {i.decision_id} · {new Date(i.created_at).toLocaleTimeString()}
            </div>
          </li>
        ))}
      </ul>
      {agent.recent_incidents.length === 0 && <p className="my-2 text-gray-500">No incidents</p>}
      {agent.recent_restorations.slice(0, 1).map((r) => (
        <p key={r.id} className="my-2 text-gray-400">
          Restored to {r.restriction} by {r.operator}: {r.reason}
        </p>
      ))}
      <details open={agent.restriction !== 'normal'}>
        <summary className="mb-2 cursor-pointer text-blue-300">Restore controls</summary>
        <form
          className="space-y-2"
          onSubmit={async (event) => {
            event.preventDefault();
            setSending(true);
            setMessage('');
            try {
              const res = await fetch(`/api/agents/${encodeURIComponent(agent.id)}/restore`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  target: agent.restriction === 'suspended' ? target : 'normal',
                  reason,
                  operator,
                }),
              });
              if (!res.ok)
                throw new Error(
                  res.status === 409
                    ? 'No recovery needed at this target, or state changed. Refresh and try again.'
                    : 'Restoration failed. Check your session and inputs.',
                );
              setReason('');
              setMessage('Restoration recorded.');
              restored();
            } catch (e) {
              setMessage(e instanceof Error ? e.message : 'Restoration failed.');
            } finally {
              setSending(false);
            }
          }}
        >
          <label className="block">
            Restore to
            <select
              aria-label={`Target state for ${agent.name}`}
              className="ml-2 rounded bg-gray-800 p-1"
              value={agent.restriction === 'suspended' ? target : 'normal'}
              onChange={(e) => setTarget(e.target.value as typeof target)}
            >
              <option value="normal">normal</option>
              {agent.restriction === 'suspended' && (
                <option value="review_required">review_required</option>
              )}
            </select>
          </label>
          <input
            aria-label={`Operator name for ${agent.name}`}
            required
            maxLength={100}
            value={operator}
            onChange={(e) => setOperator(e.target.value)}
            placeholder="Operator name (required)"
            className="w-full rounded border border-gray-600 bg-transparent p-1"
          />
          <input
            aria-label={`Restoration reason for ${agent.name}`}
            required
            maxLength={500}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Restoration reason (required)"
            className="w-full rounded border border-gray-600 bg-transparent p-1"
          />
          <button
            disabled={sending || !reason.trim() || !operator.trim()}
            className="rounded bg-blue-700 px-3 py-1 disabled:opacity-50"
          >
            {sending ? 'Restoring…' : 'Restore'}
          </button>
        </form>
      </details>
      {message && (
        <p role="status" className="mt-2">
          {message}
        </p>
      )}
    </article>
  );
}
