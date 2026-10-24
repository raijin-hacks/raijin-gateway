// The PaymentStore Chunk 1's payments module writes through (final_contracts.md section 5).
// Every method is one conditional update on the current state and returns false if it
// changed nothing. Database errors throw: the payment path never fails silently.
import type { Address, EpochMs, Money, PaymentState, PaymentStore } from '@apf/contracts';
import type { Clock } from '../clock.js';
import type { Db } from './client.js';
import { CONTRACT_SQL, EXTRA_SQL } from './statements.js';

interface PaymentRow {
  id: string;
  mandate_id: string;
  amount: Money;
  payee: string;
  state: PaymentState;
  nonce: string | null;
  valid_before: EpochMs | null;
  authorization_json: string | null;
}

/** What settle and fail need to move a payment's money. */
interface MoneyRow {
  amount: Money;
  mandate_id: string;
  day: string;
}

export function createPaymentStore(db: Db, clock: Clock): PaymentStore {
  const sqlite = db.sqlite;
  const selectPayment = sqlite.prepare<[string], PaymentRow>(
    `SELECT id, mandate_id, amount, payee, state, nonce, valid_before, authorization_json
       FROM payments WHERE id = ?`,
  );
  const selectMoney = sqlite.prepare<[string], MoneyRow>(
    'SELECT amount, mandate_id, day FROM payments WHERE id = ?',
  );
  const selectUnresolved = sqlite.prepare<[], { id: string }>(
    `SELECT id FROM payments WHERE state IN ('SIGNED','SUBMITTED','UNKNOWN') ORDER BY updated_at, id`,
  );
  /** A plain state change from `from` to `to`; `extraSet` adds columns to the SET list. */
  const transition = (from: PaymentState, to: PaymentState, extraSet = '') =>
    sqlite.prepare(
      `UPDATE payments SET state = '${to}'${extraSet}, updated_at = :now
        WHERE id = :payment_id AND state = '${from}'`,
    );
  const markSigned = sqlite.prepare(`UPDATE payments SET state = 'SIGNED', nonce = :nonce,
    valid_before = :valid_before, authorization_json = :authorization_json, updated_at = :now
    WHERE id = :payment_id AND state = 'RESERVED'
      AND EXISTS (SELECT 1 FROM mandates m JOIN decisions d ON d.mandate_id = m.id
        JOIN sessions s ON s.id = d.session_id WHERE d.id = payments.decision_id
        AND m.status = 'active' AND m.expires_at > :now AND s.status = 'active' AND s.trust >= 20)`);
  const markSubmitted = transition('SIGNED', 'SUBMITTED');
  const markUnknown = transition('SUBMITTED', 'UNKNOWN');
  // Not a state change: only the first reply is kept, and only once a paid request may have gone out.
  const saveResponse = sqlite.prepare(
    `UPDATE payments SET response_json = :response_json
      WHERE id = :payment_id AND response_json IS NULL
        AND state IN ('SUBMITTED','UNKNOWN','SETTLED')`,
  );

  /**
   * Settle and fail share one shape, run as one IMMEDIATE transaction: the payment row changes
   * first (a contract statement), and money moves only if it did, so a replay or a race can
   * never move money twice.
   */
  const moneyTransition = (paymentSql: string, moveMoney: (payment: MoneyRow) => void) => {
    const changePayment = sqlite.prepare(paymentSql);
    return sqlite.transaction((paymentId: string, params: Record<string, unknown>): boolean => {
      const payment = selectMoney.get(paymentId);
      if (!payment) return false;
      const changed = changePayment.run({ payment_id: paymentId, now: clock.now(), ...params });
      if (changed.changes !== 1) return false;
      moveMoney(payment);
      return true;
    });
  };

  const settleMandate = sqlite.prepare(CONTRACT_SQL.settleMandate);
  const settle = moneyTransition(CONTRACT_SQL.settlePayment, (p) => {
    settleMandate.run({ amount: p.amount, mandate_id: p.mandate_id });
    // tenant_daily already counts this amount (it holds spent + reserved), so it doesn't change.
  });

  const failMandate = sqlite.prepare(CONTRACT_SQL.failMandate);
  const tenantRelease = sqlite.prepare(EXTRA_SQL.tenantRelease);
  const fail = moneyTransition(CONTRACT_SQL.failPayment, (p) => {
    failMandate.run({ amount: p.amount, mandate_id: p.mandate_id });
    tenantRelease.run({ amount: p.amount, mandate_id: p.mandate_id, day: p.day });
  });

  return {
    async get(paymentId) {
      const row = selectPayment.get(paymentId);
      return row ? { ...row, payee: row.payee as Address } : null;
    },
    async markSigned(paymentId, f) {
      const result = markSigned.run({
        payment_id: paymentId,
        nonce: f.nonce,
        valid_before: f.validBefore,
        authorization_json: f.authorizationJson,
        now: clock.now(),
      });
      return result.changes === 1;
    },
    async markSubmitted(paymentId) {
      return markSubmitted.run({ payment_id: paymentId, now: clock.now() }).changes === 1;
    },
    async markUnknown(paymentId) {
      return markUnknown.run({ payment_id: paymentId, now: clock.now() }).changes === 1;
    },
    async settle(paymentId, txHash) {
      return settle.immediate(paymentId, { tx: txHash });
    },
    async fail(paymentId) {
      return fail.immediate(paymentId, {});
    },
    async listUnresolved() {
      return selectUnresolved.all().map((row) => row.id);
    },
    async saveResponse(paymentId, response) {
      const result = saveResponse.run({
        payment_id: paymentId,
        response_json: JSON.stringify(response),
      });
      return result.changes === 1;
    },
  };
}
