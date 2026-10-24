// Chunk 2-owned. The durable workflow is the coordination boundary, not a process cache.
import { createHash, createHmac, randomBytes } from 'node:crypto';
import type { PayRequest } from '@apf/contracts';
import type { Db } from '../db/client.js';
import type { AgentContext } from '../deps.js';
import { newId } from '../ids.js';

export const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export interface Workflow {
  decision_id: string;
  binding: string;
  state: 'PROCESSING' | 'REVIEW' | 'AUTHORIZED' | 'UNKNOWN' | 'TERMINAL';
  owner: string;
  catalog_revision: string;
  request_json: string;
  quote_json: string | null;
  deadline: number;
  response_json: string | null;
  reviewed_json: string;
  tier0_at: number | null;
}
export function catalogRevision(catalog: unknown): string {
  return createHash('sha256').update(JSON.stringify(catalog)).digest('hex');
}
export function workflow(db: Db, id: string): Workflow | undefined {
  return db.sqlite
    .prepare<[string], Workflow>('SELECT * FROM pay_workflows WHERE decision_id = ?')
    .get(id);
}
/** Dedicated gateway secret, persisted for the lifetime of this SQLite installation.
 * Not derived from tokens or wallet keys. DB access already conveys payment authority.
 */
export function bindingSecret(db: Db): string {
  return db.sqlite
    .transaction(() => {
      db.sqlite
        .prepare("INSERT OR IGNORE INTO gateway_secrets (id, value) VALUES ('idempotency-v1', ?)")
        .run(randomBytes(32).toString('hex'));
      return (
        db.sqlite
          .prepare("SELECT value FROM gateway_secrets WHERE id = 'idempotency-v1'")
          .get() as { value: string }
      ).value;
    })
    .immediate();
}
export function claim(
  db: Db,
  agent: AgentContext,
  request: PayRequest,
  canonicalUrl: string,
  revision: string,
  secret: string,
  now: number,
  redact = false,
) {
  const binding = createHmac('sha256', secret)
    .update(
      JSON.stringify([
        'pay-v1',
        agent.mandate.tenant_id,
        agent.mandate.agent_id,
        agent.mandate.id,
        request.method,
        canonicalUrl,
        request.expected_price,
        request.purpose,
      ]),
    )
    .digest('hex');
  return db.sqlite
    .transaction(() => {
      const existing = db.sqlite
        .prepare('SELECT id FROM decisions WHERE mandate_id = ? AND idempotency_key = ?')
        .get(agent.mandate.id, request.idempotency_key) as { id: string } | undefined;
      if (existing) {
        const saved = workflow(db, existing.id);
        return saved?.binding === binding
          ? { kind: 'replay' as const, id: existing.id }
          : { kind: 'conflict' as const };
      }
      const id = newId('decision', now);
      const owner = randomBytes(16).toString('hex');
      // Secret-bearing requests are terminal pre-contact denials, never resumable.
      const safe = redact ? { ...request, url: '[redacted]' } : request;
      db.sqlite
        .prepare(
          `INSERT INTO decisions (id, idempotency_key, mandate_id, session_id, canonical_url, method, stage, outcome, reasons_json, created_at, request_json)
      VALUES (?, ?, ?, ?, ?, ?, 'precontact', 'pending', '[]', ?, ?)`,
        )
        .run(
          id,
          request.idempotency_key,
          agent.mandate.id,
          agent.session.id,
          safe.url === '[redacted]' ? safe.url : canonicalUrl,
          request.method,
          now,
          JSON.stringify(safe),
        );
      db.sqlite
        .prepare(
          `INSERT INTO pay_workflows (decision_id, binding, state, owner, catalog_revision, request_json, deadline, reviewed_json)
      VALUES (?, ?, 'PROCESSING', ?, ?, ?, ?, '[]')`,
        )
        .run(id, binding, owner, revision, JSON.stringify(safe), now + 600000);
      return { kind: 'claimed' as const, id, owner };
    })
    .immediate();
}
