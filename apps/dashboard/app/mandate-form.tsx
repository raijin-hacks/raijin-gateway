"use client";

import { useEffect, useState } from "react";
import { dollarsToAtomic } from "../lib/money";

type Agent = { id: string; name: string };
type Merchant = { id: string; name: string; category: string };

export default function MandateForm() {
  // Options loaded from our API routes
  const [agents, setAgents] = useState<Agent[]>([]);
  const [merchants, setMerchants] = useState<Merchant[]>([]);

  // What the human types
  const [agentId, setAgentId] = useState("");
  const [task, setTask] = useState("");
  const [subjects, setSubjects] = useState<string[]>([]);
  const [subjectInput, setSubjectInput] = useState("");
  const [merchantIds, setMerchantIds] = useState<string[]>([]);
  const [budgetDollars, setBudgetDollars] = useState("2.00");
  const [expiryMinutes, setExpiryMinutes] = useState("30");

  const [error, setError] = useState("");
  const [result, setResult] = useState<unknown>(null);

  // Load agents and merchants once when the form appears
  useEffect(() => {
    fetch("/api/agents").then((r) => r.json()).then((list: Agent[]) => {
      setAgents(list);
      if (list.length > 0) setAgentId(list[0].id);
    });
    fetch("/api/catalog").then((r) => r.json()).then((c) => setMerchants(c.merchants));
  }, []);

  function addSubject() {
    const s = subjectInput.trim().toLowerCase(); // gateway normalizes the same way
    if (s && !subjects.includes(s)) setSubjects([...subjects, s]);
    setSubjectInput("");
  }

  function toggleMerchant(id: string) {
    setMerchantIds(merchantIds.includes(id)
      ? merchantIds.filter((m) => m !== id)
      : [...merchantIds, id]);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault(); // stop the browser from reloading the page
    const budget = Number(budgetDollars);
    const minutes = Number(expiryMinutes);

    if (!task.trim()) return setError("Enter a task.");
    if (subjects.length === 0) return setError("Add at least one subject.");
    if (merchantIds.length === 0) return setError("Select at least one merchant.");
    if (!(budget > 0)) return setError("Budget must be more than $0.");
    if (!(minutes > 0)) return setError("Expiry must be more than 0 minutes.");
    setError("");

    const res = await fetch("/api/mandates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent_id: agentId,
        task: task.trim(),
        subjects,
        allowed_merchant_ids: merchantIds,
        budget: dollarsToAtomic(budget),
        expires_in_ms: minutes * 60 * 1000,
      }),
    });
    setResult(await res.json());
  }

  const input = "w-full rounded border border-gray-600 bg-transparent px-2 py-1";

  return (
    <form onSubmit={submit} className="mb-8 max-w-xl space-y-3 rounded border border-gray-700 p-4">
      <h2 className="text-lg font-semibold">New mandate</h2>

      <label className="block">Agent
        <select className={input} value={agentId} onChange={(e) => setAgentId(e.target.value)}>
          {agents.map((a) => <option key={a.id} value={a.id} className="text-black">{a.name}</option>)}
        </select>
      </label>

      <label className="block">Task
        <textarea className={input} rows={3} value={task} onChange={(e) => setTask(e.target.value)}
          placeholder="Compile current list prices for 5 named competitors" />
      </label>

      <div>Subjects
        <div className="flex gap-2">
          <input className={input} value={subjectInput} onChange={(e) => setSubjectInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addSubject(); } }}
            placeholder="Type a subject, press Enter" />
          <button type="button" onClick={addSubject} className="rounded border px-2">Add</button>
        </div>
        <div className="mt-1 flex flex-wrap gap-1">
          {subjects.map((s) => (
            <button type="button" key={s} onClick={() => setSubjects(subjects.filter((x) => x !== s))}
              className="rounded bg-gray-700 px-2 text-sm">{s} ✕</button>
          ))}
        </div>
      </div>

      <fieldset>Allowed merchants
        {merchants.map((m) => (
          <label key={m.id} className="block">
            <input type="checkbox" checked={merchantIds.includes(m.id)} onChange={() => toggleMerchant(m.id)} />{" "}
            {m.name} <span className="text-gray-400">({m.category})</span>
          </label>
        ))}
      </fieldset>

      <div className="flex gap-4">
        <label>Budget ($)
          <input className={input} type="number" step="0.01" min="0" value={budgetDollars}
            onChange={(e) => setBudgetDollars(e.target.value)} />
        </label>
        <label>Expiry (minutes)
          <input className={input} type="number" min="1" value={expiryMinutes}
            onChange={(e) => setExpiryMinutes(e.target.value)} />
        </label>
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}
      <button type="submit" className="rounded bg-blue-600 px-4 py-1">Create mandate</button>

      {result !== null && (
        <pre className="overflow-x-auto text-xs">{JSON.stringify(result, null, 2)}</pre>
      )}
    </form>
  );
}