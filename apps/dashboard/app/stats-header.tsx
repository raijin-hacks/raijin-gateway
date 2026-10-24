"use client";

import { useEffect, useRef, useState } from "react";
import { subscribe } from "../lib/stream";

// Counts since page load. Each decision is counted once, at its first event
// (a pending decision can arrive again when a human resolves it).
type Totals = { decisions: number; judgeCalls: number; grantHits: number; grantMs: number[]; judgeMs: number[] };

export default function StatsHeader() {
  const startedAt = useRef(0);
  const seen = useRef(new Set<string>());
  const [totals, setTotals] = useState<Totals>({ decisions: 0, judgeCalls: 0, grantHits: 0, grantMs: [], judgeMs: [] });
  const [minutes, setMinutes] = useState(0); // since page load

  useEffect(() => {
    startedAt.current = Date.now();
    const updateMinutes = () => setMinutes((Date.now() - startedAt.current) / 60000);
    const tick = setInterval(updateMinutes, 5000); // keep the per-minute rate moving

    const unsubscribe = subscribe((events) => {
      const add: Totals = { decisions: 0, judgeCalls: 0, grantHits: 0, grantMs: [], judgeMs: [] };
      for (const e of events) {
        if (e.type !== "decision" || seen.current.has(e.decision_id)) continue;
        seen.current.add(e.decision_id);
        add.decisions++;
        if (e.stage === "judge") { add.judgeCalls++; add.judgeMs.push(e.latency_ms); }
        if (e.reasons.includes("GRANT_HIT")) { add.grantHits++; add.grantMs.push(e.latency_ms); }
      }
      if (add.decisions === 0) return;
      setTotals((t) => ({
        decisions: t.decisions + add.decisions,
        judgeCalls: t.judgeCalls + add.judgeCalls,
        grantHits: t.grantHits + add.grantHits,
        grantMs: [...t.grantMs, ...add.grantMs],
        judgeMs: [...t.judgeMs, ...add.judgeMs],
      }));
      updateMinutes();
    });

    return () => { clearInterval(tick); unsubscribe(); };
  }, []);

  const { decisions, judgeCalls, grantHits, grantMs, judgeMs } = totals;

  return (
    <section className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-5">
      <Stat label="Decisions / min" value={minutes > 0 ? (decisions / minutes).toFixed(1) : "—"} />
      <Stat label="Judge-call rate" value={percent(judgeCalls, decisions)} />
      <Stat label="Grant hit rate" value={percent(grantHits, decisions)} />
      <Stat label="Median latency, grant hit" value={ms(median(grantMs))} />
      <Stat label="Median latency, judge call" value={ms(median(judgeMs))} />
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-gray-700 p-3">
      <div className="text-xs text-gray-400">{label}</div>
      <div className="mt-1 font-mono text-2xl">{value}</div>
    </div>
  );
}

function percent(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : "—";
}

function ms(value: number | null): string {
  return value === null ? "—" : `${Math.round(value)} ms`;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
