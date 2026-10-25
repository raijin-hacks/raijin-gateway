// Chunk 2-owned. No network/payment imports: admission is supplied by startup.
import { normalizeSubject, type RestrictionState, type ReasonCode } from '@apf/contracts';
import type { AdmittedRoute } from '../judge/gateway.js';
import type { AgentContext } from '../deps.js';
import { containsSecret, urlSecretFacts } from './secrets.js';

export function precontact(
  agent: AgentContext,
  route: AdmittedRoute,
  rawUrl: string,
  now: number,
  denylist: readonly string[] = [],
  restriction: RestrictionState = 'normal',
): ReasonCode | null {
  if (restriction === 'suspended') return 'AGENT_SUSPENDED';
  if (
    agent.mandate.status !== 'active' ||
    agent.mandate.expires_at <= now ||
    agent.session.status === 'ended'
  )
    return 'NO_MANDATE';
  if (agent.session.status === 'quarantined' || agent.session.trust < 20) return 'QUARANTINED';
  if (denylist.includes(new URL(route.canonical.url).hostname)) return 'DENYLIST';
  if (containsSecret(urlSecretFacts(route.canonical))) return 'SECRET_IN_URL';
  if ((rawUrl.split('#')[0]!.split('?')[1] ?? '').length > 256) return 'QUERY_TOO_LONG';
  // Hard denials come before checks that only escalate: an unselected merchant must never reach
  // human review because some other parameter also needed a look.
  const allowedMerchants = JSON.parse(agent.mandate.allowed_merchants_json) as string[];
  if (!allowedMerchants.includes(route.match.merchant.id)) return 'MERCHANT_NOT_SELECTED';
  if (route.match.params.some((p) => p.violation)) return 'PARAM_NOT_IN_SCHEMA';
  const subjects = JSON.parse(agent.mandate.subjects_json) as string[];
  if (
    route.match.params.some(
      (p) => p.kind === 'subject' && !subjects.includes(normalizeSubject(p.value)),
    )
  )
    return 'SUBJECT_NOT_IN_MANDATE';
  return null;
}
