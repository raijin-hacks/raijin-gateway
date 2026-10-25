'use client';

import { useEffect, useState } from 'react';
import type { AgentSummary } from '@apf/contracts';
import { rememberMandateTask } from '../lib/mandate-tasks';
import { dollarsToAtomic } from '../lib/money';

type Merchant = { id: string; name: string; category: string };

export default function MandateForm() {
  // Options loaded from our API routes
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [merchants, setMerchants] = useState<Merchant[]>([]);

  // What the human types
  const [agentId, setAgentId] = useState('');
  const [task, setTask] = useState('');
  const [subjects, setSubjects] = useState<string[]>([]);
  const [subjectInput, setSubjectInput] = useState('');
  const [merchantIds, setMerchantIds] = useState<string[]>([]);
  const [budgetDollars, setBudgetDollars] = useState('2.00');
  const [expiryMinutes, setExpiryMinutes] = useState('30');

  const [error, setError] = useState('');
  // The token is shown only right after creation, then cleared for good
  const [newToken, setNewToken] = useState<{ mandateId: string; token: string } | null>(null);
  const [copied, setCopied] = useState(false);
  // Mandates created since this page loaded (no GET /mandates yet)
  const [active, setActive] = useState<{ id: string; task: string }[]>([]);

  // Load agents and merchants once when the form appears
  useEffect(() => {
    fetch('/api/agents')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`agents ${r.status}`))))
      .then((list: AgentSummary[]) => {
        setAgents(list);
        if (list.length > 0) setAgentId(list[0].id);
      })
      .catch(() => setError('Could not load agents. Is the gateway running?'));
    fetch('/api/catalog')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`catalog ${r.status}`))))
      .then((c) => setMerchants(c.merchants))
      .catch(() => setError('Could not load merchants. Is the gateway running?'));
  }, []);

  function addSubject() {
    // "acme, globex" adds two subjects: one comma-joined subject would match no request.
    const next = [...subjects];
    for (const part of subjectInput.split(',')) {
      const s = part.trim().toLowerCase(); // gateway normalizes the same way
      if (s && !next.includes(s)) next.push(s);
    }
    setSubjects(next);
    setSubjectInput('');
  }

  function toggleMerchant(id: string) {
    setMerchantIds(
      merchantIds.includes(id) ? merchantIds.filter((m) => m !== id) : [...merchantIds, id],
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault(); // stop the browser from reloading the page
    const budget = Number(budgetDollars);
    const minutes = Number(expiryMinutes);

    if (!task.trim()) return setError('Enter a task.');
    if (subjects.length === 0) return setError('Add at least one subject.');
    if (merchantIds.length === 0) return setError('Select at least one merchant.');
    if (!(budget > 0)) return setError('Budget must be more than $0.');
    if (!(minutes > 0)) return setError('Expiry must be more than 0 minutes.');
    setError('');

    const res = await fetch('/api/mandates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_id: agentId,
        task: task.trim(),
        subjects,
        allowed_merchant_ids: merchantIds,
        budget: dollarsToAtomic(budget),
        expires_in_ms: minutes * 60 * 1000,
      }),
    }).catch(() => null);
    if (!res || !res.ok) return setError('Could not create the mandate.');
    const data = await res.json();
    setNewToken({ mandateId: data.mandate_id, token: data.token });
    setCopied(false);
    setActive([{ id: data.mandate_id, task: task.trim() }, ...active]);
    rememberMandateTask(data.mandate_id, task.trim());
    // Clear the form for the next mandate
    setTask('');
    setSubjects([]);
    setMerchantIds([]);
  }

  async function closeMandate(id: string) {
    const res = await fetch(`/api/mandates/${id}/close`, { method: 'POST' }).catch(() => null);
    if (!res || !res.ok) return setError(`Could not close ${id}.`);
    setActive(active.filter((m) => m.id !== id));
  }

  async function copyToken() {
    if (!newToken) return;
    await navigator.clipboard.writeText(newToken.token);
    setCopied(true);
  }

  const input = 'w-full rounded border border-gray-600 bg-transparent px-2 py-1';

  return (
    <form onSubmit={submit} className="mb-8 max-w-xl space-y-3 rounded border border-gray-700 p-4">
      <h2 className="text-lg font-semibold">New mandate</h2>

      <label className="block">
        Agent
        <select className={input} value={agentId} onChange={(e) => setAgentId(e.target.value)}>
          {agents.map((a) => (
            <option key={a.id} value={a.id} className="text-black">
              {a.name} · {a.role} · trust {Math.round(a.trust)}
            </option>
          ))}
        </select>
        <AgentTrustNote trust={agents.find((a) => a.id === agentId)?.trust} />
      </label>

      <label className="block">
        Task
        <textarea
          className={input}
          rows={3}
          value={task}
          onChange={(e) => setTask(e.target.value)}
          placeholder="Compile current list prices for 5 named competitors"
        />
      </label>

      <div>
        Subjects
        <div className="flex gap-2">
          <input
            className={input}
            value={subjectInput}
            onChange={(e) => setSubjectInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addSubject();
              }
            }}
            placeholder="Type a subject, press Enter"
          />
          <button type="button" onClick={addSubject} className="rounded border px-2">
            Add
          </button>
        </div>
        <div className="mt-1 flex flex-wrap gap-1">
          {subjects.map((s) => (
            <button
              type="button"
              key={s}
              onClick={() => setSubjects(subjects.filter((x) => x !== s))}
              className="rounded bg-gray-700 px-2 text-sm"
            >
              {s} ✕
            </button>
          ))}
        </div>
      </div>

      <fieldset>
        Allowed merchants
        {merchants.map((m) => (
          <label key={m.id} className="block">
            <input
              type="checkbox"
              checked={merchantIds.includes(m.id)}
              onChange={() => toggleMerchant(m.id)}
            />{' '}
            {m.name} <span className="text-gray-400">({m.category})</span>
          </label>
        ))}
      </fieldset>

      <div className="flex gap-4">
        <label>
          Budget ($)
          <input
            className={input}
            type="number"
            step="0.01"
            min="0"
            value={budgetDollars}
            onChange={(e) => setBudgetDollars(e.target.value)}
          />
        </label>
        <label>
          Expiry (minutes)
          <input
            className={input}
            type="number"
            min="1"
            value={expiryMinutes}
            onChange={(e) => setExpiryMinutes(e.target.value)}
          />
        </label>
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}
      <button type="submit" className="rounded bg-blue-600 px-4 py-1">
        Create mandate
      </button>

      {newToken && (
        <div className="rounded border border-amber-500 p-3 text-sm">
          <p className="font-semibold text-amber-400">
            Copy this token now. It won&apos;t be shown again.
          </p>
          <p className="mt-1 break-all font-mono">{newToken.token}</p>
          <div className="mt-2 flex gap-2">
            <button type="button" onClick={copyToken} className="rounded border px-2">
              {copied ? 'Copied' : 'Copy'}
            </button>
            <button type="button" onClick={() => setNewToken(null)} className="rounded border px-2">
              Done, hide it
            </button>
          </div>
        </div>
      )}

      {active.length > 0 && (
        <div>
          <h3 className="font-semibold">Active mandates</h3>
          {active.map((m) => (
            <div
              key={m.id}
              className="flex items-center justify-between border-b border-gray-700 py-1 text-sm"
            >
              <span>
                <span className="font-mono">{m.id}</span> · {m.task}
              </span>
              <button
                type="button"
                onClick={() => closeMandate(m.id)}
                className="rounded border border-red-500 px-2 text-red-400"
              >
                Close
              </button>
            </div>
          ))}
        </div>
      )}
    </form>
  );
}

// A new mandate's session starts at the agent's trust, so a low agent score changes what it can buy.
// Thresholds from final_contracts.md section 2, pipeline step 7.
function AgentTrustNote({ trust }: { trust: number | undefined }) {
  if (trust === undefined || trust >= 60) return null;
  const text =
    trust < 20
      ? 'Quarantined: every payment under a new mandate for this agent will be denied.'
      : trust < 40
        ? 'Low trust: every payment will need a human.'
        : 'Reduced trust: grants are ignored, so every new payment goes to the judge.';
  return <p className={`mt-1 text-sm ${trust < 20 ? 'text-red-400' : 'text-amber-400'}`}>{text}</p>;
}
