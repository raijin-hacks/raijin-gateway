'use client';

import { Fragment, useEffect, useRef, useState } from 'react';
import type { StreamEvent } from '@apf/contracts';
import { formatMoney } from '../lib/money';
import { subscribe } from '../lib/stream';

const MAX_ROWS = 500;

type Decision = Extract<StreamEvent, { type: 'decision' }>;
// `key` is our own counter: the same decision_id can arrive twice (pending, then resolved)
type Row = { key: number; event: Decision };

const OUTCOME_COLOR: Record<Decision['outcome'], string> = {
  approved: 'text-green-400',
  denied: 'text-red-400',
  pending: 'text-amber-400',
};

export default function EventFeed() {
  const [rows, setRows] = useState<Row[]>([]);
  const [openKey, setOpenKey] = useState<number | null>(null);
  const nextKey = useRef(0);
  // decision_id + stage + outcome of every row shown; the gateway can publish the same decision twice
  const shown = useRef(new Set<string>());

  useEffect(
    () =>
      subscribe((events) => {
        const incoming: Row[] = [];
        for (const event of events) {
          if (event.type !== 'decision') continue;
          const id = `${event.decision_id}|${event.stage}|${event.outcome}`;
          if (shown.current.has(id)) continue;
          shown.current.add(id);
          incoming.unshift({ key: nextKey.current++, event }); // newest first
        }
        if (incoming.length > 0) setRows((prev) => [...incoming, ...prev].slice(0, MAX_ROWS));
      }),
    [],
  );

  return (
    <section>
      <h2 className="mb-2 text-lg font-semibold">Decisions</h2>
      <table className="w-full text-left text-sm">
        <thead className="text-gray-400">
          <tr>
            <th className="py-1 pr-3 font-normal">Time</th>
            <th className="pr-3 font-normal">Mandate</th>
            <th className="pr-3 font-normal">Stage</th>
            <th className="pr-3 font-normal">Outcome</th>
            <th className="pr-3 font-normal">Reasons</th>
            <th className="pr-3 text-right font-normal">Price</th>
            <th className="text-right font-normal">Latency</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ key, event: e }) => (
            <Fragment key={key}>
              <tr
                onClick={() => setOpenKey(openKey === key ? null : key)}
                className="cursor-pointer border-t border-gray-700 hover:bg-gray-800"
              >
                <td className="py-1 pr-3 font-mono">{new Date(e.at).toLocaleTimeString()}</td>
                <td className="pr-3 font-mono">{e.mandate_id}</td>
                <td className="pr-3">{e.stage}</td>
                <td className={`pr-3 font-semibold ${OUTCOME_COLOR[e.outcome]}`}>{e.outcome}</td>
                <td className="pr-3">
                  <div className="flex flex-wrap gap-1">
                    {e.reasons.map((r) => (
                      <span key={r} className="rounded bg-gray-700 px-1.5 text-xs">
                        {r}
                      </span>
                    ))}
                  </div>
                </td>
                <td className="pr-3 text-right font-mono">
                  {e.price !== null ? formatMoney(e.price) : '—'}
                </td>
                <td className="text-right font-mono">{e.latency_ms} ms</td>
              </tr>
              {openKey === key && (
                <tr>
                  <td colSpan={7}>
                    <pre className="overflow-x-auto bg-gray-900 p-2 text-xs">
                      {JSON.stringify(e, null, 2)}
                    </pre>
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </section>
  );
}
