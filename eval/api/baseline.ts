import { createInjectedJudge } from '../../apps/gateway/src/judge/index.js';

export const BASELINE_VERSION = 'selected-merchant-operation-v1';
/** Fixed policy over trusted merchant/operation facts; no task-text matching or model. */
export function createCategoryBaseline() {
  return createInjectedJudge({
    async judge(input) {
      const blocked =
        !input.payment.merchant.known ||
        !input.payment.merchant.selected_for_mandate ||
        !input.payment.endpoint.known ||
        /bulk|export|subscription/i.test(input.payment.endpoint.category);
      return {
        decision: blocked ? 'deny' : 'approve',
        reasons: [blocked ? 'JUDGE_OFF_TASK' : 'JUDGE_APPROVED'],
        explanation: `Deterministic ${BASELINE_VERSION} policy.`,
        injection_suspected: false,
      };
    },
  });
}
