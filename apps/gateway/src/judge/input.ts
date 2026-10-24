import { judgeInputSchema, normalizeSubject } from '@apf/contracts';
import type { JudgeContext, JudgeInput, JudgeParam } from '@apf/contracts';
import { JudgeError } from './index.js';

/** Sole live-context projection. Match parameter names and values are untrusted. */
export function buildInput(ctx: JudgeContext): JudgeInput {
  try {
    if (ctx.match.kind !== 'known') throw new JudgeError('JUDGE_ERROR');
    const { merchant, endpoint, params } = ctx.match;
    if (ctx.method !== endpoint.method) throw new JudgeError('JUDGE_ERROR');
    const projected: JudgeParam[] = [];
    // Iterate trusted declarations, never raw names. Violations can survive human
    // review, so neither the match's kind nor its raw value authorizes disclosure.
    for (const name of Object.keys(endpoint.params)) {
      const spec = endpoint.params[name]!;
      if (spec.kind === 'forbidden') continue;
      const occurrences = params.filter((param) => param.name === name);
      if (occurrences.length !== 1) continue;
      const param = occurrences[0]!;
      const safe: JudgeParam = { name, kind: spec.kind };
      if (param.violation === null && param.kind === spec.kind && typeof param.value === 'string') {
        if (spec.kind === 'subject') {
          const subject = ctx.mandate.subjects.find(
            (subject) => normalizeSubject(subject) === normalizeSubject(param.value),
          );
          if (subject !== undefined) safe.value = subject;
        } else if (spec.type === 'enum') {
          const value = spec.values.find((value) => value === param.value);
          if (value !== undefined) safe.value = value;
        }
      }
      projected.push(safe);
    }
    return judgeInputSchema.parse({
      mandate: {
        task: ctx.mandate.task,
        subjects: ctx.mandate.subjects.map((subject) => subject),
        budget_remaining: ctx.mandate.budget_remaining,
        expires_in_ms: ctx.mandate.expires_in_ms,
      },
      role_policy: ctx.role_policy,
      payment: {
        price: ctx.price,
        purpose: ctx.purpose,
        merchant: {
          known: true,
          name: merchant.name,
          category: merchant.category,
          description: merchant.description,
          selected_for_mandate: ctx.mandate.allowed_merchant_ids.includes(merchant.id),
        },
        endpoint: {
          known: true,
          method: ctx.method,
          category: endpoint.category,
          description: endpoint.description,
        },
        payee: {
          first_seen: ctx.payee_facts.first_seen,
          prior_calls: ctx.payee_facts.prior_calls,
          recent_prices: ctx.payee_facts.recent_prices.map((price) => price),
        },
        params: projected,
        url_shape: null,
      },
    });
  } catch {
    // Context validation must not disclose raw values through validation errors.
    throw new JudgeError('JUDGE_ERROR');
  }
}
