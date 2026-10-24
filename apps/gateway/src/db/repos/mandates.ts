import { and, desc, eq } from 'drizzle-orm';
import type { Money } from '@apf/contracts';
import { newId } from '../../ids.js';
import type { Db } from '../client.js';
import { agents, grants, mandates, sessions } from '../schema.js';

export type MandateRow = typeof mandates.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
export type AgentRow = typeof agents.$inferSelect;

export interface NewMandate {
  tenantId: string;
  agentId: string;
  task: string;
  /** Already normalized (trim, lowercase, deduped). */
  subjects: string[];
  allowedMerchantIds: string[];
  budget: Money;
  expiresAt: number;
  tokenHash: string;
  createdBy: string;
  /** The session starts at the agent's current trust. */
  sessionTrust: number;
  now: number;
}

export function createMandateRepo(db: Db) {
  const { orm } = db;

  return {
    findAgent(agentId: string): AgentRow | undefined {
      return orm.select().from(agents).where(eq(agents.id, agentId)).get();
    },

    /** Creates the mandate and its first session together. */
    create(input: NewMandate): { mandateId: string; sessionId: string } {
      const mandateId = newId('mandate', input.now);
      const sessionId = newId('session', input.now);
      db.sqlite.transaction(() => {
        orm
          .insert(mandates)
          .values({
            id: mandateId,
            tenant_id: input.tenantId,
            agent_id: input.agentId,
            task: input.task,
            subjects_json: JSON.stringify(input.subjects),
            allowed_merchants_json: JSON.stringify(input.allowedMerchantIds),
            budget: input.budget,
            status: 'active',
            token_hash: input.tokenHash,
            expires_at: input.expiresAt,
            created_by: input.createdBy,
            created_at: input.now,
          })
          .run();
        orm
          .insert(sessions)
          .values({
            id: sessionId,
            mandate_id: mandateId,
            agent_id: input.agentId,
            trust: input.sessionTrust,
            status: 'active',
            created_at: input.now,
          })
          .run();
      })();
      return { mandateId, sessionId };
    },

    /** The mandate and its latest session, if the token is for an active, unexpired mandate. */
    findActiveByTokenHash(
      tokenHash: string,
      now: number,
    ): { mandate: MandateRow; session: SessionRow } | null {
      const mandate = orm.select().from(mandates).where(eq(mandates.token_hash, tokenHash)).get();
      if (!mandate || mandate.status !== 'active' || mandate.expires_at <= now) return null;
      const session = orm
        .select()
        .from(sessions)
        .where(eq(sessions.mandate_id, mandate.id))
        .orderBy(desc(sessions.created_at))
        .get();
      return session ? { mandate, session } : null;
    },

    /**
     * Closes an active mandate (which revokes its token), deletes its grants and ends its
     * active sessions. Returns false if no such mandate exists. Safe to call twice.
     */
    close(mandateId: string): boolean {
      return db.sqlite.transaction(() => {
        const found = orm
          .select({ id: mandates.id })
          .from(mandates)
          .where(eq(mandates.id, mandateId))
          .get();
        if (!found) return false;
        orm
          .update(mandates)
          .set({ status: 'closed' })
          .where(and(eq(mandates.id, mandateId), eq(mandates.status, 'active')))
          .run();
        orm.delete(grants).where(eq(grants.mandate_id, mandateId)).run();
        orm
          .update(sessions)
          .set({ status: 'ended' })
          .where(and(eq(sessions.mandate_id, mandateId), eq(sessions.status, 'active')))
          .run();
        return true;
      })();
    },
  };
}
