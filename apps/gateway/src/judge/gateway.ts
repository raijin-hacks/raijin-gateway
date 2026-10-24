import type { Catalog, HttpMethod, JudgeContext, JudgeModule, JudgeOutput } from '@apf/contracts';
import { createCanonicalizer, matchEndpoint, routeMatch } from '../catalog/index.js';
import type { Canonical } from '../catalog/index.js';
import { JudgeError, validateOutput } from './index.js';

export type AdmittedRoute = {
  canonical: Canonical;
  method: HttpMethod;
  match: Extract<JudgeContext['match'], { kind: 'known' }>;
};
export type AdmissionHold =
  | { kind: 'deny'; reason: 'BAD_URL' | 'DUPLICATE_PARAM' | 'UNCATALOGED_ENDPOINT' };

/** Startup composition only. No quote/grant/judge callback can run for an unknown route.
 * Admission is not SSRF verification or payment authorization. Callers still own every
 * pre-contact check, reservation, trust/grant routing and durable continuation.
 */
export function createGatewayAdmission(catalog: Catalog) {
  const canonicalize = createCanonicalizer(catalog);
  return Object.freeze({
    catalog,
    async run<T>(
      rawUrl: string,
      method: HttpMethod,
      next: (route: AdmittedRoute) => Promise<T>,
    ): Promise<T | AdmissionHold> {
      const canonical = canonicalize(rawUrl);
      if (!canonical.ok) return { kind: 'deny', reason: canonical.code };
      const route = routeMatch(matchEndpoint(canonical, method, catalog));
      if (route.kind === 'deny') return route;
      return next({ canonical, method, match: route.match });
    },
  });
}

export type GatewayJudgeResult =
  | { kind: 'deny'; reason: 'JUDGE_ERROR' | 'JUDGE_INVALID_OUTPUT'; quarantine: false }
  | { kind: 'deny'; reason: 'INJECTION_SUSPECTED'; quarantine: true }
  | { kind: 'judged'; output: JudgeOutput; quarantine: false };

/** Invoke only after Tier 0/reservation/trust/grant routing. This result conveys no
 * signing authority. Chunk 2 must recheck mandate state and clamp grant proposals.
 * Reservation cleanup belongs to that owner, not a second competing finally block.
 */
export async function runGatewayJudge(
  judge: JudgeModule,
  context: JudgeContext,
): Promise<GatewayJudgeResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (context.match.kind !== 'known') throw new JudgeError('JUDGE_ERROR');
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new JudgeError('JUDGE_ERROR')), 5000);
    });
    // Revalidate even an injected module; a partially valid approval cannot escape.
    const output = validateOutput(
      await Promise.race([judge.judge(judge.buildInput(context)), deadline]),
    );
    // Injection overrides approval, escalation and any proposed grant.
    if (output.injection_suspected)
      return { kind: 'deny', reason: 'INJECTION_SUSPECTED', quarantine: true };
    return { kind: 'judged', output, quarantine: false };
  } catch (error) {
    return {
      kind: 'deny',
      reason: error instanceof JudgeError ? error.code : 'JUDGE_ERROR',
      quarantine: false,
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
