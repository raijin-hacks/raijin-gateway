# Trust design: tightening-only restriction

Oct 24, 2026 · Status: **implemented** · Owner: Chunk 2 (pipeline/policy), with Chunk 3 (eval) and Chunk 4 (pitch)

Sources: [`critic.md`](../critic.md) Part 3, [`Design.md`](Design.md) (trust section), and a read-only review of `origin/main` at `f121f17`. Line references below are to that revision.

## Summary

Trust in this project is a **heuristic routing score**, not a permission system. At the historical baseline it moved both ways: denials lowered it, and approvals raised it again. The implementation keeps the idea the team liked ("start every agent conservative, get stricter after mistakes") but makes it **monotonic**: automation can only tighten an agent's treatment, and only an explicit, audited human action can loosen it.

The rule this doc adopts:

> **Trust changes how much friction an agent gets, never what it's allowed to buy.** Mandates, role caps and the catalog set the boundary. Trust can add review or suspend; it never raises a limit.

This is supporting policy, not the headline. It buys consistency and a truthful pitch, not a large novelty bonus.

## Historical baseline at f121f17 (before this implementation)

| Area | Current behavior on `main` | Where |
|---|---|---|
| Baseline | Seeded research and bulk roles start at trust 70, with a $1 per-call cap, velocity limits 20 and 120, and a $20 tenant daily cap. Seed data, not a tenant policy product. | [`db/seed.ts:8–38,75–86`](../apps/gateway/src/db/seed.ts) |
| Penalties | Tier 0 denial: −5 session / −1 agent. Off-task: −15 / −3. Injection: −30 / −5, plus session quarantine. Human rejection: −20 / −5. Pre-contact denials: no penalty. | [`contracts/constants.ts:42–50`](../packages/contracts/src/constants.ts), [`pipeline/index.ts:218–225`](../apps/gateway/src/pipeline/index.ts) |
| Automatic recovery | Grant or judge approval: +1 session / +0.2 agent. Human approval: +2 session. Capped by the role baseline and the agent's score. | [`pipeline/policy.ts:306–330`](../apps/gateway/src/pipeline/policy.ts) |
| Thresholds | Below 60: no grants. Below 40: human review (`TRUST_REQUIRES_HUMAN`). Below 20: purchases denied. Final approval rechecks session trust. | [`pipeline/policy.ts:42–48,101–103,195–213`](../apps/gateway/src/pipeline/policy.ts), [`pipeline/index.ts:244–250`](../apps/gateway/src/pipeline/index.ts) |
| Persistence | Agent trust persists across mandates; new mandates inherit it. A downgrade updates the agent and the triggering session only, not the agent's other open sessions. | [`routes/mandates.ts:34–45`](../apps/gateway/src/routes/mandates.ts), [`pipeline/policy.ts:318–330`](../apps/gateway/src/pipeline/policy.ts) |
| Money | Trust never lowers per-call limits; role caps are fixed. | `pipeline/policy.ts` |

**Consequence for the pitch:** the Devpost line "trust only ever tightens" was **false at that baseline**, because approvals added points back ([`demo/DEVPOST.md:29`](../demo/DEVPOST.md)). Either implement this doc or change that line.

## Why the larger trust ideas were cut

From the team proposal (`design-docs/local/proposal-plan-lock.md`) and critic Part 3 (`critic.md:536–545`, `457–462`):

- **Learned promotion** (clean runs raise trust, unlocking auto-renew or bigger budgets): an attacker can behave normally, earn trust, then strike. Farming trust would buy power.
- **The 25% budget tier for new agents:** arbitrary, slows legitimate work, and run resets undermine it.
- **Autonomous plan edits for high-trust agents** (Claude raises a price cap or adds a subject): enlarges authority without a human and can ratchet beyond what was approved.
- **The original numbers are unvalidated.** [`Design.md`](Design.md) (trust section, and line ~541) calls the thresholds and deltas invented. Tuning them is not evidence.

Critic Part 3's recommended reading is already the one adopted here: human-approved authority is immutable; trust may add friction or suspend; only humans change scope.

## Implemented policy

### States

Replace "a number that drifts both ways" with an explicit, persistent **restriction state** per agent. The existing score can stay as an internal input.

| State | Effect | Enter by | Leave by |
|---|---|---|---|
| `normal` | Current behavior within mandate and role limits; grants allowed. | Default for a new agent (or the enterprise-configured baseline). | Automatic, on a qualifying incident. |
| `review_required` | Grants disabled; every purchase that reaches authorization needs human approval. | A qualifying incident while `normal`. | **Only** an explicit operator restoration action. |
| `suspended` | All new purchases denied before contact. | A severe incident, or repeated incidents while `review_required`. | **Only** an explicit operator restoration action. |

Movement is downward-only automatically. Approving a single purchase never restores the state.

### Baseline

Every agent starts at a conservative default (the current role caps and mandate budgets) unless an enterprise customizes its role. No new percentage tiers and no dynamic money ledger: the baseline is the existing role policy, and restriction only adds friction on top.

### What counts as an incident

Restrictions trigger only on **defined security incidents**, deduplicated per decision:

| Signal | Treatment |
|---|---|
| Injection flag from the judge | Incident → `review_required` (and session quarantine, as today) |
| Payee swap / price-switch Tier 0 denial | Incident → `review_required` |
| Human rejection of a reviewed purchase | Incident → `review_required` |
| Repeated incidents (e.g. 2 within a mandate) while `review_required` | → `suspended` |
| Off-task judgment (`JUDGE_OFF_TASK`) | **Review signal, not proof of compromise.** Counts toward review only, not suspension. |
| `JUDGE_ERROR`, model/transport outage, malformed input, pre-contact `BAD_URL` / `UNCATALOGED_ENDPOINT` | **Not an incident.** Never penalize the agent for infrastructure failures or for attacker pages it merely read. |

The off-task and pre-contact exclusions matter: otherwise a malicious page could degrade a legitimate agent and flood the approval queue.

### Human restoration

A separate, authenticated, audited operator action (for example `POST /agents/:id/restore`, admin only) with: target state, reason (required), and the operator's identity. It is logged and appears on the dashboard. Approving one payment in the queue is **not** a restoration.

## Implementation sketch (Chunk 2)

1. **Remove automatic upward deltas** from grant/judge approvals and human approvals (`pipeline/policy.ts:306–330`, constants in `packages/contracts/src/constants.ts:42–50`). Keep penalties.
2. **Add persistent state:** an `agents.restriction` column (`normal | review_required | suspended`) plus an append-only `agent_incidents` table keyed by decision ID (dedup). Drizzle migration.
3. **Enforce at every authorization boundary:** pre-contact (suspended → deny), grant lookup (not `normal` → no grant), final approval commit and signing guard (recheck inside the same transaction as today's trust recheck), human resume and restart recovery.
4. **Propagate across sessions:** check the durable agent state, not just the triggering session's score, so other open sessions and new mandates see the restriction.
5. **Restoration endpoint** (admin only), plus a dashboard control (Chunk 4).
6. **Contract:** document the states, incident table and restoration endpoint in `final_contracts.md` (bundle with the next contract version).

## Tests (acceptance)

- No recovery path: clean approvals, grant hits, new mandates, cached grants, concurrent approvals or another open session cannot move an agent back to `normal`.
- Each incident type moves the state as specified; `JUDGE_ERROR`, outages and pre-contact denials do not.
- Incidents are deduplicated per decision (retries and replays don't double-count).
- `suspended` denies before any quote, judge call or signature.
- Restoration requires admin auth, records a reason, and is the only upward transition.
- Concurrency: a restriction committed mid-judge is honored at final approval (same pattern as the existing approval-time trust recheck).

## Benefits and risks

**Gains:** consistent with the "plans decide what an agent can buy; trust decides how much babysitting it needs" pitch, without the farming problem. Removing automatic promotion eliminates compliant-purchase trust farming.

**Doesn't solve:** fresh-identity laundering (a new agent starts clean), silent mistakes that never produce a denial, or overspending inside an overly broad approved envelope. Explicit permissions (plan-lock, [`docs/judge-advisories.md`](../docs/judge-advisories.md)) remain the real boundary.

**Risks:** false positives punishing legitimate agents (mitigated by the incident taxonomy and the off-task-as-signal rule), approval-queue spam, and added policy surface.

## Implementation details and clarifications

The full scope is implemented, including the admin restoration endpoint, dashboard control, incident history, event contracts and offline rehearsal. Contracts are v1.4. Run `pnpm trust:rehearse` or `pnpm agent:rehearse` for the scripted mock-payment beat.

- Suspension means two security incidents in the same mandate since the last restoration. Off-task rows never count. Dedup is per decision, including a later human rejection of an already recorded off-task review; that decision contributes only its first signal.
- The proposal did not identify a separate severe detector. The internal incident transition supports severe security incidents (tested), but no listed first incident is silently promoted to severe. Agent and public API inputs cannot set severity.
- Existing numeric penalties remain; approval deltas are zero. Off-task penalties stop at 20 without raising lower scores, preserving the explicit review-only rule. Quote/infrastructure errors no longer incur the old catch-all Tier 0 penalty.
- Restoration requires a less restrictive target (or the same target when heuristic scores/quarantine need recovery), reason and operator name. It also explicitly resets heuristic scores and clears quarantine on unended sessions in active mandates, so restoration actually permits work again. It never reopens expired/closed mandates or changes their authority. Incident epochs prevent pre-restoration history from immediately undoing a restoration.
- Shared admin authentication establishes the admin principal. Operator names are self-attested, as the existing dashboard login has no named-user accounts. The immutable audit stores the name and reason, and the server log records the admin principal.
- SQLite triggers enforce append-only incidents and restorations. The migration adds a checked state column without rebuilding the referenced agents table. GET /agents exposes the ten latest incidents and restorations; the dashboard refreshes from this durable source, including after missed stream events.
- Durable guards run before contact, grants, final authorization, human resume, recovery, immediately before signing, and atomically when recording SIGNED. A restriction during an external signing call prevents storing/submitting the result; already-issued signatures cannot be recalled. Submitted/unknown payments remain reconciled and reserved.
- Injection still quarantines the triggering session. The demo shows another already-open session of the same agent entering review; restoration explicitly clears the quarantine. The offline rehearsal uses an explicit injection-flag stub and does not claim live detection of attacker prose (the judge never sees page text).

Acceptance coverage lives in `apps/gateway/test/http/trust-restriction.test.ts`, `apps/agent/src/trust-rehearsal.test.ts`, the payment-store/signer tests and doc-driven contract tests. Existing approval/replay tests now expect zero reward events; concurrent incident tests expect the durable `AGENT_REVIEW_REQUIRED` reason instead of score-only routing. No live eval labels, judge prompt, CDP policy or agent tool behavior was changed.
