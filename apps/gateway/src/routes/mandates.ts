// POST /mandates and POST /mandates/:id/close (admin; CHUNK-2-GATEWAY.md G3).
import {
  CreateMandateRequestSchema,
  normalizeSubjects,
  type CreateMandateResponse,
} from '@apf/contracts';
import type { Handler } from 'hono';
import { hashToken, newMandateToken } from '../auth.js';
import { createMandateRepo } from '../db/repos/mandates.js';
import type { AppEnv, Deps } from '../deps.js';
import { badRequest, notFound, readJson } from '../http.js';

export function createMandate(deps: Deps): Handler<AppEnv> {
  const repo = createMandateRepo(deps.db);
  const catalogMerchants = new Set(deps.catalog.merchants.map((m) => m.id));

  return async (c) => {
    const body = await readJson(c, CreateMandateRequestSchema);
    if (!body.ok) return body.response;
    const req = body.value;

    const agent = repo.findAgent(req.agent_id);
    if (!agent) return badRequest(c, [{ path: 'agent_id', message: 'Unknown agent' }]);
    const merchantIds = [...new Set(req.allowed_merchant_ids)];
    const unknown = merchantIds.filter((id) => !catalogMerchants.has(id));
    if (unknown.length > 0) {
      return badRequest(c, [
        { path: 'allowed_merchant_ids', message: `Not in the catalog: ${unknown.join(', ')}` },
      ]);
    }

    const now = deps.clock.now();
    const token = newMandateToken();
    const { mandateId, sessionId } = repo.create({
      tenantId: agent.tenant_id,
      agentId: agent.id,
      task: req.task,
      subjects: normalizeSubjects(req.subjects),
      allowedMerchantIds: merchantIds,
      budget: req.budget,
      expiresAt: now + req.expires_in_ms,
      tokenHash: hashToken(token),
      createdBy: 'admin',
      sessionTrust: agent.trust,
      now,
    });
    deps.log.info('mandate created', {
      mandate_id: mandateId,
      agent_id: agent.id,
      budget: req.budget,
      expires_at: now + req.expires_in_ms,
    });
    const response: CreateMandateResponse = { mandate_id: mandateId, session_id: sessionId, token };
    return c.json(response, 201);
  };
}

export function closeMandate(deps: Deps): Handler<AppEnv, '/mandates/:id/close'> {
  const repo = createMandateRepo(deps.db);
  return async (c) => {
    const mandateId = c.req.param('id');
    if (!repo.close(mandateId)) return notFound(c);
    await deps.pipeline?.sweep();
    deps.log.info('mandate closed', { mandate_id: mandateId });
    return c.json({ ok: true });
  };
}
