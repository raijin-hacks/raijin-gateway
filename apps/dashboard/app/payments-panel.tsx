'use client';

import { useEffect, useRef, useState } from 'react';
import type { PaymentState, PaymentStatusResponse } from '@apf/contracts';
import { formatMoney } from '../lib/money';
import { subscribe } from '../lib/stream';

const MAX_ROWS = 100;
const EXPLORER = 'https://base-sepolia.blockscout.com/tx/';

type Row = {
  paymentId: string;
  state: PaymentState;
  amount: number;
  at: number;
  payee: string | null;
  txHash: string | null;
};

const STATE_COLOR: Record<PaymentState, string> = {
  RESERVED: 'text-gray-400',
  SIGNED: 'text-gray-400',
  SUBMITTED: 'text-amber-400',
  UNKNOWN: 'text-amber-400',
  SETTLED: 'text-green-400',
  FAILED: 'text-gray-400', // not an error: see STATE_LABEL
};

// FAILED means the payment was proven not to settle and its reserved money was released. Shown as
// "released" so it doesn't read as a crash; the raw state stays in the tooltip.
const STATE_LABEL: Partial<Record<PaymentState, string>> = { FAILED: 'released · nothing paid' };

// Payments since the page loaded, newest first: one row per payment, updated in place as its
// state moves. The stream gives state and amount; the payee and tx hash come from the gateway.
export default function PaymentsPanel() {
  const [rows, setRows] = useState<Row[]>([]);
  const lookups = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const timers = lookups.current;

    async function lookUp(paymentId: string) {
      timers.delete(paymentId);
      const res = await fetch(`/api/payments/${paymentId}`).catch(() => null);
      if (!res || !res.ok) return;
      const p: PaymentStatusResponse | null = await res.json();
      if (!p) return; // MOCK mode
      setRows((prev) =>
        prev.map((r) =>
          r.paymentId === paymentId
            ? { ...r, state: p.state, payee: p.payee, txHash: p.tx_hash }
            : r,
        ),
      );
    }

    const unsubscribe = subscribe((events) => {
      const updates = events.filter((e) => e.type === 'payment');
      if (updates.length === 0) return;
      setRows((prev) => {
        let next = prev;
        for (const e of updates) {
          const row = { state: e.state, amount: e.amount, at: e.at };
          next = next.some((r) => r.paymentId === e.payment_id)
            ? next.map((r) => (r.paymentId === e.payment_id ? { ...r, ...row } : r))
            : [{ paymentId: e.payment_id, payee: null, txHash: null, ...row }, ...next];
        }
        return next.slice(0, MAX_ROWS);
      });
      // Several states can arrive together; ask the gateway once they settle down.
      for (const e of updates) {
        clearTimeout(timers.get(e.payment_id));
        timers.set(
          e.payment_id,
          setTimeout(() => lookUp(e.payment_id), 500),
        );
      }
    });

    return () => {
      unsubscribe();
      for (const t of timers.values()) clearTimeout(t);
    };
  }, []);

  return (
    <section className="mb-8">
      <h2 className="mb-2 text-lg font-semibold">Payments</h2>
      {rows.length === 0 ? (
        <p className="text-sm text-gray-400">No payments since this page loaded.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-gray-400">
              <tr>
                <th className="py-1 pr-3 font-normal">Time</th>
                <th className="pr-3 font-normal">Payment</th>
                <th className="pr-3 font-normal">State</th>
                <th className="pr-3 text-right font-normal">Amount</th>
                <th className="pr-3 font-normal">Payee</th>
                <th className="font-normal">Transaction</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.paymentId} className="border-t border-gray-700">
                  <td className="py-1 pr-3 font-mono whitespace-nowrap">
                    {new Date(r.at).toLocaleTimeString()}
                  </td>
                  <td className="pr-3 font-mono whitespace-nowrap">{r.paymentId}</td>
                  <td
                    className={`pr-3 font-semibold whitespace-nowrap ${STATE_COLOR[r.state]}`}
                    title={
                      r.state === 'FAILED'
                        ? 'Payment state FAILED: it never settled, and the money reserved for it was released.'
                        : undefined
                    }
                  >
                    {STATE_LABEL[r.state] ?? r.state}
                  </td>
                  <td className="pr-3 text-right font-mono">{formatMoney(r.amount)}</td>
                  <td className="pr-3 font-mono">{r.payee ? shorten(r.payee) : '—'}</td>
                  <td className="font-mono">
                    <TxLink hash={r.txHash} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// A real settlement links to the explorer. Mock payments store a fake hash ("mock:…"), which is
// labeled, never linked, so nothing on screen looks like a chain receipt that doesn't exist.
function TxLink({ hash }: { hash: string | null }) {
  if (!hash) return <span className="text-gray-500">—</span>;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash))
    return <span className="text-gray-400">mock, no chain tx</span>;
  return (
    <a href={EXPLORER + hash} target="_blank" rel="noreferrer" className="text-blue-400 underline">
      {shorten(hash)}
    </a>
  );
}

function shorten(hex: string): string {
  return hex.length > 14 ? `${hex.slice(0, 8)}…${hex.slice(-6)}` : hex;
}
