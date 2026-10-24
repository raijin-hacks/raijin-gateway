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

export function createPaymentStore(db: Db, clock: Clock): PaymentStore {
  const sqlite = db.sqlite;
  const selectPayment = sqlite.prepare<[string], PaymentRow>(
    `SELECT id, mandate_id, amount, payee, state, nonce, valid_before, authorization_json
       FROM payments WHERE id = ?`,
  );
  const selectMoney = sqlite.prepare<[string], { amount: Money; mandate_id: string; day: string }>(
    'SELECT amount, mandate_id, day FROM payments WHERE id = ?',
  );
  const selectUnresolved = sqlite.prepare<[], { id: string }>(
    `SELECT id FROM payments WHERE state IN ('SIGNED','SUBMITTED','UNKNOWN') ORDER BY updated_at, id`,
  );
  const markSigned = sqlite.prepare(
    `UPDATE payments SET state = 'SIGNED', nonce = :nonce, valid_before = :valid_before,
            authorization_json = :authorization_json, updated_at = :now
      WHERE id = :payment_id AND state = 'RESERVED'`,
  );
  const markSubmitted = sqlite.prepare(
    `UPDATE payments SET state = 'SUBMITTED', updated_at = :now
      WHERE id = :payment_id AND state = 'SIGNED'`,
  );
  const markUnknown = sqlite.prepare(
    `UPDATE payments SET state = 'UNKNOWN', updated_at = :now
      WHERE id = :payment_id AND state = 'SUBMITTED'`,
  );
  const settlePayment = sqlite.prepare(CONTRACT_SQL.settlePayment);
  const settleMandate = sqlite.prepare(CONTRACT_SQL.settleMandate);
  const failPayment = sqlite.prepare(CONTRACT_SQL.failPayment);
  const failMandate = sqlite.prepare(CONTRACT_SQL.failMandate);
  const tenantRelease = sqlite.prepare(EXTRA_SQL.tenantRelease);

  // Settle and fail each run in one IMMEDIATE transaction. The payment row changes first, and
  // money moves only if it did, so a replay or a race can never move money twice.
  const settle = sqlite.transaction((paymentId: string, txHash: string): boolean => {
    const payment = selectMoney.get(paymentId);
    if (!payment) return false;
    const changed = settlePayment.run({ payment_id: paymentId, tx: txHash, now: clock.now() });
    if (changed.changes !== 1) return false;
    settleMandate.run({ amount: payment.amount, mandate_id: payment.mandate_id });
    // tenant_daily already counts this amount (it holds spent + reserved), so it doesn't change.
    return true;
  });

  const fail = sqlite.transaction((paymentId: string): boolean => {
    const payment = selectMoney.get(paymentId);
    if (!payment) return false;
    const changed = failPayment.run({ payment_id: paymentId, now: clock.now() });
    if (changed.changes !== 1) return false;
    failMandate.run({ amount: payment.amount, mandate_id: payment.mandate_id });
    tenantRelease.run({ amount: payment.amount, mandate_id: payment.mandate_id, day: payment.day });
    return true;
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
      return settle.immediate(paymentId, txHash);
    },
    async fail(paymentId) {
      return fail.immediate(paymentId);
    },
    async listUnresolved() {
      return selectUnresolved.all().map((row) => row.id);
    },
  };
}
