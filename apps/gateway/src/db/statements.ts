// The atomic statements from final_contracts.md section 1, copied verbatim. A test checks
// them against the document. Never replace them with read-then-write logic.
export const CONTRACT_SQL = {
  // Reserve (one statement; changes() = 0 means MANDATE_BUDGET denial)
  reserve: `UPDATE mandates SET reserved = reserved + :amount
 WHERE id = :mandate_id AND status = 'active' AND expires_at > :now
   AND spent + reserved + :amount <= budget`,

  // Settle (in one transaction; only proceed to the second statement if the first changed 1 row)
  settlePayment: `UPDATE payments SET state = 'SETTLED', tx_hash = :tx, updated_at = :now
 WHERE id = :payment_id AND state IN ('SIGNED','SUBMITTED','UNKNOWN')`,
  settleMandate: `UPDATE mandates SET reserved = reserved - :amount, spent = spent + :amount WHERE id = :mandate_id`,

  // Fail (same pattern; only when non-settlement is proven)
  failPayment: `UPDATE payments SET state = 'FAILED', updated_at = :now
 WHERE id = :payment_id AND state IN ('RESERVED','SIGNED','SUBMITTED','UNKNOWN')`,
  failMandate: `UPDATE mandates SET reserved = reserved - :amount WHERE id = :mandate_id`,

  // Grant use (changes() = 0 means GRANT_EXHAUSTED)
  useGrant: `UPDATE grants SET used_total = used_total + :amount
 WHERE id = :grant_id AND used_total + :amount <= max_total AND expires_at > :now`,
} as const;

// Proposed additions (CHUNK-2-BUILD-PLAN.md D3, D5, D6), written in the same conditional style:
// each changes exactly one row on success and zero when its limit would be passed.
export const EXTRA_SQL = {
  // Adds to the tenant's total for the day, unless that would pass tenants.daily_cap.
  tenantCommit: `INSERT INTO tenant_daily (tenant_id, day, committed)
SELECT tenant_id, :day, :amount FROM mandates
 WHERE id = :mandate_id AND :amount <= (SELECT daily_cap FROM tenants WHERE id = mandates.tenant_id)
ON CONFLICT (tenant_id, day) DO UPDATE SET committed = committed + excluded.committed
 WHERE committed + excluded.committed <= (SELECT daily_cap FROM tenants WHERE id = tenant_daily.tenant_id)`,

  // Gives a failed payment's amount back to the day it was reserved on.
  tenantRelease: `UPDATE tenant_daily SET committed = committed - :amount
 WHERE tenant_id = (SELECT tenant_id FROM mandates WHERE id = :mandate_id) AND day = :day`,

  insertReservedPayment: `INSERT INTO payments (id, decision_id, mandate_id, amount, payee, state, updated_at, quote_json, day)
VALUES (:id, :decision_id, :mandate_id, :amount, :payee, 'RESERVED', :now, :quote_json, :day)`,

  // Adds to a standing grant's use for the day, unless that would pass its daily_total.
  standingGrantUse: `INSERT INTO standing_grant_usage (standing_grant_id, day, used_total)
SELECT id, :day, :amount FROM standing_grants WHERE id = :standing_grant_id AND :amount <= daily_total
ON CONFLICT (standing_grant_id, day) DO UPDATE SET used_total = used_total + excluded.used_total
 WHERE used_total + excluded.used_total <= (SELECT daily_total FROM standing_grants WHERE id = standing_grant_usage.standing_grant_id)`,
} as const;
