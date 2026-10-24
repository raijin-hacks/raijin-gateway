// Reserving money and using grants: the conditional updates Tier 0 and Tier 1 rely on.
import type { Address, EpochMs, Money } from '@apf/contracts';
import type { Clock } from '../clock.js';
import { newId } from '../ids.js';
import type { Db } from './client.js';
import { CONTRACT_SQL, EXTRA_SQL } from './statements.js';

export interface ReserveRequest {
  mandateId: string;
  decisionId: string;
  amount: Money;
  payee: Address;
  /** The quote being paid, stored for retries and for resuming after a human approves. */
  quoteJson: string;
}

export type ReserveResult =
  { ok: true; paymentId: string } | { ok: false; code: 'TENANT_DAILY' | 'MANDATE_BUDGET' };

/** The UTC calendar day (YYYY-MM-DD) that tenant and standing-grant daily totals use. */
export function utcDay(now: EpochMs): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** Thrown inside the reservation transaction to roll it back with a reason code. */
class Refused extends Error {
  constructor(readonly code: 'TENANT_DAILY' | 'MANDATE_BUDGET') {
    super(code);
  }
}

export function createFunds(db: Db, clock: Clock) {
  const sqlite = db.sqlite;
  const tenantCommit = sqlite.prepare(EXTRA_SQL.tenantCommit);
  const reserveMandate = sqlite.prepare(CONTRACT_SQL.reserve);
  const insertPayment = sqlite.prepare(EXTRA_SQL.insertReservedPayment);
  const useGrant = sqlite.prepare(CONTRACT_SQL.useGrant);
  const useStandingGrant = sqlite.prepare(EXTRA_SQL.standingGrantUse);

  // The tenant's daily total, the mandate's reservation and the RESERVED payment row commit
  // together or not at all (build plan D3, D5). The tenant check runs first so TENANT_DAILY
  // wins over MANDATE_BUDGET, matching the Tier 0 rule order.
  const reserveTx = sqlite.transaction((req: ReserveRequest, now: number): string => {
    const day = utcDay(now);
    const tenant = tenantCommit.run({ mandate_id: req.mandateId, day, amount: req.amount });
    if (tenant.changes !== 1) throw new Refused('TENANT_DAILY');
    const mandate = reserveMandate.run({ mandate_id: req.mandateId, amount: req.amount, now });
    if (mandate.changes !== 1) throw new Refused('MANDATE_BUDGET');
    const paymentId = newId('payment', now);
    insertPayment.run({
      id: paymentId,
      decision_id: req.decisionId,
      mandate_id: req.mandateId,
      amount: req.amount,
      payee: req.payee,
      now,
      quote_json: req.quoteJson,
      day,
    });
    return paymentId;
  });

  return {
    /**
     * Holds `amount` against the tenant's day and the mandate's budget, and creates the
     * decision's RESERVED payment. Refusals change nothing. A decision that already has a
     * payment throws (one payment per decision), and that rolls back too.
     */
    reserve(req: ReserveRequest): ReserveResult {
      try {
        return { ok: true, paymentId: reserveTx.immediate(req, clock.now()) };
      } catch (error) {
        if (error instanceof Refused) return { ok: false, code: error.code };
        throw error;
      }
    },

    /** Counts `amount` against a grant. False means GRANT_EXHAUSTED (or expired, or unknown). */
    useGrant(grantId: string, amount: Money): boolean {
      return useGrant.run({ grant_id: grantId, amount, now: clock.now() }).changes === 1;
    },

    /** Counts `amount` against a standing grant's daily_total for today. False means exhausted. */
    useStandingGrant(standingGrantId: string, amount: Money): boolean {
      const day = utcDay(clock.now());
      const result = useStandingGrant.run({ standing_grant_id: standingGrantId, day, amount });
      return result.changes === 1;
    },
  };
}

export type Funds = ReturnType<typeof createFunds>;
