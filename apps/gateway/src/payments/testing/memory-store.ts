// In-memory PaymentStore obeying contracts §5: every transition is conditional on the current state.
// Stand-in until Chunk 2 delivers the SQLite store. Records every call so tests can check the order of writes.
import type { Address, EpochMs, Money, PaymentState, PaymentStore } from '@apf/contracts';

type Row = NonNullable<Awaited<ReturnType<PaymentStore['get']>>> & {
  tx_hash: string | null;
  response_json: string | null;
};

export class MemoryPaymentStore implements PaymentStore {
  rows = new Map<string, Row>();
  calls: { method: string; paymentId: string; changed: boolean }[] = [];

  // Not part of PaymentStore: the gateway creates the RESERVED row before payments ever sees it.
  reserve(id: string, f: { amount: Money; payee: Address; mandate_id?: string }): void {
    this.rows.set(id, {
      id,
      mandate_id: f.mandate_id ?? 'mnd_test',
      amount: f.amount,
      payee: f.payee,
      state: 'RESERVED',
      nonce: null,
      valid_before: null,
      authorization_json: null,
      tx_hash: null,
      response_json: null,
    });
  }

  // Not part of PaymentStore: puts a row straight into a state, for tests that start mid-lifecycle.
  seed(row: Partial<Row> & { id: string; state: PaymentState }): void {
    this.rows.set(row.id, {
      mandate_id: 'mnd_test',
      amount: 0,
      payee: '0x0000000000000000000000000000000000000000',
      nonce: null,
      valid_before: null,
      authorization_json: null,
      tx_hash: null,
      response_json: null,
      ...row,
    });
  }

  async get(paymentId: string) {
    const row = this.rows.get(paymentId);
    return row ? { ...row } : null;
  }

  async markSigned(
    paymentId: string,
    f: { nonce: string; validBefore: EpochMs; authorizationJson: string },
  ) {
    return this.transition('markSigned', paymentId, ['RESERVED'], 'SIGNED', {
      nonce: f.nonce,
      valid_before: f.validBefore,
      authorization_json: f.authorizationJson,
    });
  }
  async markSubmitted(paymentId: string) {
    return this.transition('markSubmitted', paymentId, ['SIGNED'], 'SUBMITTED');
  }
  async markUnknown(paymentId: string) {
    return this.transition('markUnknown', paymentId, ['SUBMITTED'], 'UNKNOWN');
  }
  async settle(paymentId: string, txHash: string) {
    return this.transition('settle', paymentId, ['SIGNED', 'SUBMITTED', 'UNKNOWN'], 'SETTLED', {
      tx_hash: txHash,
    });
  }
  async fail(paymentId: string) {
    return this.transition(
      'fail',
      paymentId,
      ['RESERVED', 'SIGNED', 'SUBMITTED', 'UNKNOWN'],
      'FAILED',
    );
  }
  async listUnresolved() {
    return [...this.rows.values()]
      .filter((r) => ['SIGNED', 'SUBMITTED', 'UNKNOWN'].includes(r.state))
      .map((r) => r.id);
  }

  async saveResponse(
    paymentId: string,
    response: { status_code: number; content_type: string; body: string },
  ) {
    const row = this.rows.get(paymentId);
    const changed =
      !!row &&
      row.response_json === null &&
      ['SUBMITTED', 'UNKNOWN', 'SETTLED'].includes(row.state);
    if (changed) row.response_json = JSON.stringify(response);
    this.calls.push({ method: 'saveResponse', paymentId, changed });
    return changed;
  }

  called(method: string): number {
    return this.calls.filter((c) => c.method === method).length;
  }

  private transition(
    method: string,
    paymentId: string,
    from: PaymentState[],
    to: PaymentState,
    fields: Partial<Row> = {},
  ) {
    const row = this.rows.get(paymentId);
    const changed = !!row && from.includes(row.state);
    if (changed) Object.assign(row, fields, { state: to });
    this.calls.push({ method, paymentId, changed });
    return changed;
  }
}
