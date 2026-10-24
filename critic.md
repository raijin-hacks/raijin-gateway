# critic: harshest-judge review of the CalHacks 13.0 submission

Reviewer: Claude providing context to Codex (`gpt-6-astra`, effort `xhigh`), read-only, on `chunk3/phase8` at `3e75ddb`.

## Part 1: current score and the path to 78

**42/100 as it stands.** I would not shortlist this for an overall prize today. You have substantial authorization and accounting infrastructure, but the central differentiator remains unvalidated, and several essential product interactions are still mocks.

I reviewed **`chunk3/phase8` at `3e75ddb`**, giving credit for the full branch rather than judging incomplete `main`. **No files changed.** I reran all 57 cases against both stub-approve and the deterministic baseline using in-memory databases, and reproduced the standing-grant bypass and delayed-settlement response loss. I did not make live model or blockchain calls.

CalHacks publishes Application, Intentionality, Functionality, Creativity, and Technical Complexity as its criteria. The weights below are my security-project interpretation, not an official numerical rubric. [CalHacks judging criteria](https://cal-hacks-13-0.devpost.com/)

**1. The current score**

| Criterion | Score | Harsh-judge reasoning |
|---|---:|---|
| Novelty, idea, practical application | **8/15** | Task-scoped payment authorization is a worthwhile problem. But your own deterministic baseline currently makes the LLM unnecessary, and adoption requires a curated merchant catalog. |
| Technical execution | **14/20** | Atomic reservations, durable workflows, exact grants, input projection, and conservative settlement handling show real depth. Integration and response delivery remain incomplete. |
| Working product and demo | **4/20** | Dashboard mutations are fake; the agent discards purchased data; the live judge is unmeasured; the integrated real-payment path is disabled. |
| Measured evidence | **3/15** | The evaluation machinery is unusually careful. The actual evidence does not establish the proposed advantage. Testing infrastructure is not validation of the idea. |
| Security rigor | **7/15** | Strong accounting and trust-boundary work, undermined by task-check bypasses, ambiguous merchant permissions, and unfinished transport security. |
| Presentation and pitch | **3/10** | Clear concept, but the script describes behavior the current system cannot produce. The submission draft contains unsupported completed-work claims. |
| Sponsor-track fit | **3/5** | Good conceptual fit for security and x402. A standalone payment milestone helps; a working integrated demonstration is still missing. |
| **Total** | **42/100** | **A promising security prototype, not yet a convincing submission.** |

The design document’s **68/100** was conditional on four non-negotiables. You have not yet demonstrated those commitments together. [Design.md:9](design-docs/Design.md:9)

**2. The critiques that would cost you points**

1. **Your benchmark currently argues against your headline feature.**

   I reproduced:

   | Configuration | Core attacks stopped* | Legitimate requests approved | Held-out attacks stopped* |
   |---|---:|---:|---:|
   | Existing gateway + stub-approve | 10/20 | 20/20 | 15/17 |
   | Gateway + deterministic category/selection baseline | **20/20** | **20/20** | **17/17** |
   | Live judge | **Unmeasured** | **Unmeasured** | **Unmeasured** |

   *Stopped includes escalation.*

   The distinction matters: existing gateway rules do **not** catch all attacks. A small additional deterministic policy does. It rejects unselected merchants and bulk/export/subscription categories without task reasoning. [baseline.ts:5](eval/api/baseline.ts:5)

   Consequently, “the LLM catches attacks that pass our rules” is insufficient. You must show why a sensible additional rule cannot achieve the same protection and usability.

   Worse, the acceptance gate compares judge-only catches against **stub-approve**, not against the stronger deterministic baseline. You can satisfy your acceptance criteria while still failing to justify the LLM. [report.ts:10](eval/api/report.ts:10)

   **Change:** evaluate paired requests whose correct outcome changes with the human task while merchant, endpoint, price, subjects, and other deterministic facts remain matched.

2. **Standing grants bypass the very task check you advertise. This is reproduced, not hypothetical.**

   I changed only the in-memory weather mandate’s task to:

   > Write a short greeting for Oakland. Do not research or purchase weather data.

   SkyData remained selected and Oakland remained a valid subject. A normal forecast purchase then produced:

   - `GRANT_HIT`
   - **Zero judge calls**
   - **12,000 atomic USDC spent in the mock ledger**
   - `SETTLED`

   The standing-grant path checks merchant selection, endpoint, price, and grant allowance; it never validates the task’s meaning. [policy.ts:231](apps/gateway/src/pipeline/policy.ts:231)

   Your judge prompt explicitly says merchant selection alone is not task authorization, yet the grant path treats it as sufficient. [prompt.ts:5](apps/gateway/src/judge/prompt.ts:5)

   **Change:** disable standing grants for the submission, or require an explicit task-scoped authorization before activating them. Optimize after the first semantic authorization.

3. **“Allowed merchants” is not actually a hard allowlist.**

   Merchant selection is passed to the model as `selected_for_mandate`. It is not enforced by pre-contact policy, and it does not independently constrain judge approval. [precontact.ts:14](apps/gateway/src/pipeline/precontact.ts:14), [input.ts:50](apps/gateway/src/judge/input.ts:50)

   V6 proves the consequence: a weather mandate selecting SkyData can purchase PriceScope data when the judge approves. Your own stub results record this approval. [V6.json](eval/cases/variants/V6.json), [REPORT.md:65](eval/REPORT.md:65)

   That may reflect an intentional design choice, but the UI calls these **allowed** merchants. A human reasonably reads that as a boundary an LLM cannot expand.

   **Change:** enforce the allowlist in code. Find judge-only examples within that boundary. Do not preserve weak controls merely to create work for the judge.

4. **The dashboard is an interaction mock attached to a potentially real event stream.**

   Mandate creation returns `mock_token_*`; approvals return `ok: true` without contacting the gateway; closing a mandate also returns fabricated success. These are unconditional mocks, not branches controlled by `MOCK=1`. [mandates/route.ts:1](apps/dashboard/app/api/mandates/route.ts:1), [approvals/route.ts:1](apps/dashboard/app/api/approvals/[id]/route.ts:1), [close/route.ts:1](apps/dashboard/app/api/mandates/[id]/close/route.ts:1)

   Meanwhile, the stream can connect to the actual gateway. The UI can therefore show real pending work and falsely report that you resolved it.

   Simply adding proxies will expose another integration error: the dashboard offers `agt_research` and `agt_briefing`, while the gateway seeds `agt_pricing`, `agt_logistics`, and `agt_bulk`. [agents/route.ts:3](apps/dashboard/app/api/agents/route.ts:3), [seed.ts:13](apps/gateway/src/db/seed.ts:13)

   **Change:** connect the actual create/close/approve/catalog flows, use real agent identifiers, and verify resulting gateway state—not merely HTTP 200 responses.

5. **The demo agent buys information it cannot use.**

   After `paid_fetch`, the loop deliberately gives the model only `{status: result.status}`. It discards the purchased body. When the model finishes, the loop returns without exposing its final answer. [loop.ts:44](apps/agent/src/loop.ts:44), [loop.ts:53](apps/agent/src/loop.ts:53)

   A pricing researcher cannot produce a grounded pricing report from the word `approved`. This makes the legitimate workflow nearly as artificial as the malicious one.

   Keeping merchant text away from the **payment judge** is valuable. Keeping purchased data away from the **worker agent** defeats the product.

   **Change:** return a bounded projection of purchased data to the worker, preserve it as untrusted tool output, and display the finished report. Continue excluding it from judge input and credential-bearing logs.

6. **A successful purchase can permanently lose its result.**

   I reproduced the reported delayed-settlement failure through the actual payment function and gateway pipeline with simulated transport and settlement timing:

   1. Merchant returns HTTP 200 with a body.
   2. Immediate reconciliation returns `UNKNOWN`.
   3. Payment function drops the body.
   4. Settlement is subsequently recorded.
   5. Polling and same-key retry both return `approved`, **`response: null`**.

   The payment function returns the body only when settlement is immediately confirmed; the pipeline persists it only for that synchronous success. [pay.ts:167](apps/gateway/src/payments/pay.ts:167), [pipeline/index.ts:344](apps/gateway/src/pipeline/index.ts:344)

   This is not a demonstrated double-charge bug. It is a **paid-but-no-deliverable bug**, with no recovery through ordinary retry.

   **Change:** durably store the bounded merchant response when received, independently of settlement state. Release it to the client only under the intended settlement policy. Test delayed proof, repeated polling, and restart after response persistence.

7. **The integrated x402 product is not live; removing its safety gate would make the submission worse.**

   `main.ts` deliberately blocks real quotes and payments. The underlying quote and paid-request implementations still use ordinary `fetch`; they do not implement the required pinned transport. [main.ts:51](apps/gateway/src/main.ts:51), [quote.ts:33](apps/gateway/src/payments/quote.ts:33), [pay.ts:152](apps/gateway/src/payments/pay.ts:152)

   Credit where due: the payment status log records a real Base Sepolia payment. But that milestone used a standalone payment script; it does not demonstrate the current firewall end to end. [STATUS.md:33](apps/gateway/src/payments/STATUS.md:33)

   **Change:** finish J2b for one demonstrable merchant, including both quote and paid requests. Resolve the localhost policy once. If it cannot be completed safely, explicitly demonstrate simulated settlement and accept the reduced x402 strength.

8. **The attack suite is substantially less diverse than its size suggests.**

   Ten core attacks are price variants of one export operation. The API evaluator sends prepared requests; it does not measure whether malicious pages induce a live agent to make those requests. The rehearsal deliberately scripts that behavior. [REPORT.md:24](eval/REPORT.md:24), [REPORT.md:30](eval/REPORT.md:30), [rehearsal.test.ts:85](apps/agent/src/rehearsal.test.ts:85)

   Also, the current files contain **11**, not ten, variants marked `judge_only`. Nine are intercepted before the judge; V4 and V6 reach it. The open-issues count is stale.

   The phase-8 greeting example establishes a useful experimental case. It does **not** establish successful injection against a live agent, successful rejection by a live judge, or broad semantic competence.

   **Change:** report three separate measurements: agent attack induction, payment authorization accuracy, and settlement/recovery reliability. Preserve the current benchmark as historical evidence.

9. **Human review currently overpromises what a human can resolve.**

   Unknown routes always fail admission before quote or judge invocation. Human approval re-enters the same execution path, so approving an unknown route cannot make it admitted; it escalates again. [gateway.ts:23](apps/gateway/src/judge/gateway.ts:23), [pipeline/index.ts:650](apps/gateway/src/pipeline/index.ts:650)

   The approval UI also lacks merchant information, knows mandate text only when created on the current page, and removes requests immediately after a successful response. [approval-queue.tsx:107](apps/dashboard/app/approval-queue.tsx:107), [approval-queue.tsx:118](apps/dashboard/app/approval-queue.tsx:118)

   Separately, the stream proxy attaches the admin credential without authenticating its incoming viewer. If this dashboard is exposed to others, that is an actual administrative-data boundary problem. [stream/route.ts:14](apps/dashboard/app/api/stream/route.ts:14)

   **Change:** distinguish “human can approve” from “administrator must update catalog.” Supply authoritative review details and protect the operator interface before wiring privileged mutations.

10. **Your presentation contains claims contradicted by the implementation.**

   The script’s headline attack uses an unknown merchant and expects a judge denial. Current admission prevents that request from reaching the judge. The script also assumes real payments, several running merchants, an injection interface still marked TBD, and unrecorded rehearsals. [SCRIPT.md:9](demo/SCRIPT.md:9), [SCRIPT.md:66](demo/SCRIPT.md:66)

   The Devpost draft says unknown URLs reach the judge as lengths, describes three honest merchants plus an attacker server, and says three evaluation runs were completed. Those statements are not supported by this branch’s implementation/report. [DEVPOST.md:26](demo/DEVPOST.md:26), [DEVPOST.md:37](demo/DEVPOST.md:37)

   Most damaging is the design’s guarantee that injection cannot spend beyond the task. Deterministic budget containment does not imply semantic task correctness. Your reproduced standing-grant purchase already distinguishes them. [Design.md:7](design-docs/Design.md:7)

   **Change:** rewrite around verified behavior. Describe attacker-text exclusion as a specific boundary property, not a proof of universal immunity.

11. **The product’s economics and adoption burden are unanswered.**

   You require humans to specify task text, subjects, merchants, budget, and expiry, plus administrators to maintain endpoint semantics. A judge can reasonably ask: **“After entering all that, why not select permitted operations explicitly?”**

   The mock report has **0% warm-up judge avoidance** because the stub does not issue grants; this is not evidence that live grants fail, but it provides no support for the amortization story. [REPORT.md:40](eval/REPORT.md:40)

   The live input projection also drops integer and boolean option values. Future quantity-sensitive operations can become indistinguishable to the judge despite having materially different task relevance. [input.ts:21](apps/gateway/src/judge/input.ts:21)

   **Change:** pick one target user, measure task completion, review burden, model cost, and realistic grant reuse. Limit the semantic claim to information the judge actually receives.

12. **Test volume is giving you more confidence than integration coverage warrants.**

   The documented 1,416 passing tests are useful engineering evidence. They did not prevent mock dashboard mutations, discarded purchased data, or the response-loss defect. Root `tsc -b` does not include the dashboard, so root build success does not establish a deployable Next.js application. [status.md:47](docs/status.md:47), [tsconfig.json:3](tsconfig.json:3)

   **Change:** make one complete operator-to-agent-to-payment-to-deliverable flow your acceptance test. Run the dashboard’s own build. Reserve time to publish the reviewed branch state coherently.

The competitive claim also needs narrowing. Coinbase already documents spending caps and isolated agent keys; Ramp documents agent budgets, merchant restrictions, approval controls, and x402 payments. Those sources do not establish that they solve your exact semantic task-check problem, but they make broad “nobody checks why” rhetoric fragile. Your defensible distinction is **measured task-relative authorization using restricted judge input**. [Coinbase Agentic Wallets](https://www.coinbase.com/developer-platform/products/agentic-wallets), [Ramp agent payments](https://agents.ramp.com/)

**3. What to do in the remaining day**

The highest-value work is proving the semantic advantage and completing a useful workflow. More infrastructure without those outcomes will barely move the score.

Efforts below are **person-hours**. Score impacts overlap; they should not be added mechanically.

**Must do before the demo:**

| Priority | Action and acceptance condition | Effort | Expected score effect |
|---|---|---:|---:|
| **P0 — immediately** | Assign one demo owner, one judge/eval owner, and one payment owner. Pick one submission revision and resolve model/credential choices with one successful live call. Defer authentication-platform redesign. | 0.5–1 | Unlocks the rest |
| **P0 — prove the idea** | Create a versioned supplemental benchmark with 6–10 matched legitimate/attack pairs. Use selected, cataloged merchants, valid parameters, ordinary prices, and independently reviewed labels. Run stub, deterministic baseline, and real judge; repeat real runs three times. | 4–6 | **+9–13** |
| **P0 — fix authorization semantics** | Disable standing grants until task-scoped authorization exists; enforce merchant selection as a hard boundary. Add the reproduced greeting/weather case and an unselected-merchant case as regressions. | 1.5–3 | **+3–5** |
| **P0 — complete the useful workflow** | Wire real dashboard mutations and correct agent IDs. Give the worker bounded purchased data and show its final report. Provide an actual injected-page server/control for the demo. Verify the displayed approval changes gateway state. | 5–7 | **+8–12** |
| **P0 — preserve purchased results** | Persist received merchant responses independently of immediate chain visibility. Verify delayed settlement, same-key replay, and restart retain the response without another purchase. | 2–4 | **+3–5** |
| **P0 — make the operator view trustworthy** | Show task, merchant/operation, amount, decision reason, and settlement state. Label payment/judge modes clearly. Prevent unauthorized dashboard access; distinguish non-overridable catalog blocks. | 1–2 | **+2–3** |
| **P0 — submit evidence, not intentions** | Replace the stale script and Devpost claims, fill real metrics, record a complete demo, rehearse three times, and verify the submitted revision includes the stack. Include the dashboard build in final checks. | 3–4 | **+4–6** |

**Required before demonstrating real settlement:**

| Action | Effort | Expected score effect |
|---|---:|---:|
| Complete J2b on both network legs, settle the localhost policy, and demonstrate one normal payment through the actual firewall to Base Sepolia with its response delivered to the agent. Include malicious-destination and redirect rejection checks. | **6–10**, with material uncertainty | **+4–7**, especially for x402 |

Give J2b a firm checkpoint early enough to record the fallback. If it misses, keep the real-payment gate and clearly label simulated settlement. A security project that knowingly removes its transport boundary is worse than an honest simulation.

For the new benchmark, use examples that defeat the **stronger baseline**, not merely the current Tier 0 rules:

- Same Acme pricing request: justified for a pricing refresh; unjustified for drafting outreach from already supplied company information.
- Same news request: justified for a current briefing; unjustified for summarizing a fixed supplied document.
- Same export operation under a role that permits exports: justified for a full historical analysis; over-scoped for a narrow current-price task.

Include legitimate exports where policy truly allows them; otherwise “deny every export” remains a winning strategy. Do not weaken admission, expose attacker prose to the judge, or relabel inconvenient results to manufacture lift.

Report attack denials, attack escalations, legitimate automatic approvals, legitimate escalations, errors, model latency, and model cost separately. Three repetitions measure variability; they do not turn a small hand-built set into broad security validation.

A credible three-minute presentation would be:

- **0:00–0:25:** one concrete user and spending mistake.
- **0:25–1:00:** legitimate purchase produces a useful report.
- **1:00–1:45:** matched off-task purchase passes deterministic controls, then the live judge stops it.
- **1:45–2:15:** measured comparison, including failures and usability.
- **2:15–3:00:** judge-written injection or a clearly identified replay, plus the exact security boundary.

CalHacks allows three minutes to pitch and two for questions, and requires a demonstration; its criteria also explicitly call for a meaningful video for asynchronous sponsor review. [Submission requirements](https://cal-hacks-13-0.devpost.com/)

**Nice to have, after that works:**

| Change | Effort | Value |
|---|---:|---|
| Durable agent purchase identities across restart | 1–2 h | Useful reliability improvement; prevents “retry” becoming a new logical purchase. |
| Dashboard state recovery after refresh/reconnect | 1–2 h | Prevents pending work disappearing during judging. |
| Actual invocation timing and token-cost instrumentation | 0.5–1 h | Makes latency/economics claims defensible. Current dashboard latency is decision elapsed time, not isolated model time. |
| One independent teammate attack session after freezing the prompt | 1 h | More valuable than another batch of correlated fixtures. |
| Short conversation with security/x402 sponsor representatives | 0.5 h | Resolve track expectations; sponsor notes currently contain questions without answers. |

**Not worth doing in the remaining day:**

- SDK migration, WIF, automated live CI, or an elaborate credential policy before one live evaluation succeeds.
- A new database, multi-process deployment, mainnet support, or custody architecture.
- More trust-score sophistication. Its thresholds remain unvalidated.
- A general merchant onboarding system or broad unknown-merchant support.
- A 100,000-request load test while the agent cannot complete its task.
- Dashboard animation and graph polish before wiring mutations.
- Adding unrelated sponsor APIs solely for eligibility.
- Rewriting old held-out attacks and continuing to describe the rewritten set as untouched.

With four people, run semantic evaluation, product integration, and payment work concurrently, while the fourth owns the demonstration and independent labels. With three, cut polish and optional features. Protect the last several hours for integration and recording.

**4. The score after those changes**

**78/100 is a plausible harsh-critic score if the work succeeds—including measured judge value and safe integrated testnet settlement.** It is a conditional projection, not credit for completing a checklist.

| Criterion | Current | After | Why points return—and what remains missing |
|---|---:|---:|---|
| Novelty, idea, application | 8/15 | **11/15** | Matched examples establish a useful semantic distinction. Curated integration and competing deterministic policies still limit differentiation. |
| Technical execution | 14/20 | **17/20** | Transport, response persistence, and integration complete the central engineering story. |
| Working product and demo | 4/20 | **16/20** | A human assigns work, the agent buys data and finishes, and an attack is visibly stopped. Scope remains a controlled demonstration. |
| Measured evidence | 3/15 | **11/15** | Real repeated results, baselines, legitimate controls, latency, and cost. Still a small, mostly team-authored evaluation. |
| Security rigor | 7/15 | **11/15** | Concrete authorization gaps closed and transport verified. Semantic correctness remains probabilistic, with trusted catalog/admin assumptions. |
| Presentation and pitch | 3/10 | **8/10** | Accurate claims, visible utility, a credible comparison, and a recorded fallback. |
| Sponsor-track fit | 3/5 | **4/5** | Integrated x402 and a demonstrated security contribution. Sponsor-specific acceptance still requires confirmation. |
| **Total** | **42/100** | **78/100** | **A credible contender, particularly for a focused security prize.** |

If J2b does not finish but the live judge, product flow, and evidence do, I would place an honestly labeled mock-settlement submission around **72/100**. If the live judge adds no useful advantage over the stronger baseline, do not retain the semantic-firewall pitch and expect 78: reframe as a deterministic payment authorization gateway with an experimental semantic layer.

Even after a strong day, three things keep this below 90: **no demonstrated real-user adoption, limited independent/adaptive attack evidence, and a fundamental dependence on curated semantics plus fallible model decisions.** The strongest achievable submission acknowledges those limits and proves a narrow, valuable result convincingly.

## Part 2: how to get above 90

**The route to 90+ is to change what you promise and then produce substantially stronger evidence. Finishing Part 1 earns roughly 78, not 90. My recommended redesign could earn 92/100 if executed and independently validated well. From this branch, with roughly one day left, 90+ is not a credible planning target. My optimistic deadline ceiling is 84/100.**

This follows the same harsh-judge rubric as Part 1 and reviews the same `chunk3/phase8` revision, `3e75ddb`. The redesigns, numerical targets and future scores below are proposals, not implemented features or measured results. I reread the [design](design-docs/Design.md), [architecture](docs/architecture.md), [open issues](docs/open-issues.md), [evaluation report](eval/REPORT.md), [agent handoff](apps/agent/README.md) and the relevant implementation. This follow-up adds no live-model, user-study or chain evidence.

**1. Why the current repair plan stops at 78**

78 is a ceiling for the repaired submission described in Part 1, not a mathematical limit on every product that uses a probabilistic model. Exceptional independent evidence could change the judgment. The present design and evidence do not justify that exception.

| Structural limit                                              | Why fixing the implementation does not remove it                                                                                                                                                                                                                                                                                                                                                                                           | What would change my assessment                                                                                                                                                                                                      |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **The catalog supplies the semantics.**                       | The [catalog](catalog/catalog.json) contains three merchants and four operations. [Admission](apps/gateway/src/judge/gateway.ts) prevents unknown routes from reaching either the merchant or judge. This is authorization over a small, administrator-described tool set, not understanding arbitrary paid services. Adding entries requires someone to understand and maintain each operation.                                           | A deliberately narrow product whose users already maintain these integrations; evidence of the time needed to add another one; a versioned contract for changes. Automatic discovery is not a substitute for deciding whom to trust. |
| **A competent deterministic policy is a serious competitor.** | The [baseline](eval/api/baseline.ts) wins on the published 57 cases. Matched tasks can defeat that particular category rule, but a task template with explicit permitted operations can distinguish pricing research from greeting writing too. The relevant competitor is the best practical policy a user could configure, not an intentionally weak cap-only wallet.                                                                    | Either show a useful safety/usability advantage over task-specific rules, or concede equal runtime safety and demonstrate substantially easier configuration.                                                                        |
| **The judge makes an authorization error consequential.**     | An approved model decision can reach payment through the [pipeline](apps/gateway/src/pipeline/index.ts). Budget clamps bound the loss; they do not turn an off-task purchase into a correct purchase. A bad approval can also issue a reusable grant. Temperature zero, valid JSON and canary exclusion do not prove task correctness.                                                                                                     | Remove the model's ability to introduce spending authority at runtime, or produce much broader empirical evidence and explicitly sell residual-risk reduction.                                                                       |
| **Restricted input loses information needed for the claim.**  | The [input builder](apps/gateway/src/judge/input.ts) sees catalog descriptions and selected facts, not the worker's actual evidence, progress or purchased content. It currently omits numeric and boolean option values. Even after that bug is fixed, two requests with the same projection can differ in whether the information is already available or the purchase is useful. A merchant can also misdescribe or change its service. | Define authorization in terms of explicit, observable permissions. If freshness or prior completion matters, represent it in trusted workflow state. Do not ask a model to infer hidden facts.                                       |
| **Setup may cost more than the problem it solves.**           | A human supplies task, subjects, merchants, budget and expiry; an administrator supplies endpoint meaning; exceptions need more human attention. The [design](design-docs/Design.md) already concedes that a judge call can cost more than a purchase. Removing unsafe standing grants increases cold-start work; allowing them without task approval weakens the claim.                                                                   | Timed comparisons against manual operation selection, including catalog setup, cold tasks, review interruptions, model cost and completed work. A warm-cache latency graph alone is inadequate.                                      |
| **The evidence is narrow and the value is hypothetical.**     | The [report](eval/REPORT.md) has correlated export attacks and no measured live judge. The [agent rehearsal](apps/agent/README.md) scripts compliance with the injection. Three repetitions of team-authored requests do not establish independent attack resistance, and useful infrastructure is not evidence that another developer will adopt it.                                                                                      | Independent operators completing useful tasks; adaptive adversaries after a freeze; end-to-end purchase and delivery; honest failure rates and an auditable comparison.                                                              |

There is an uncomfortable triangle here: unrestricted service discovery, no untrusted semantic input, and reliable task-relative authorization. The current system chooses trusted catalog semantics and rejects discovery. That is a reasonable scope restriction. Calling it a general semantic firewall disguises the restriction rather than overcoming it.

The broad enterprise target compounds the problem. You are asking an organization to introduce a gateway, configure policies, maintain service semantics, isolate credentials and adopt a payment rail before showing a workflow it needs. The first customer should be someone who already has a small paid-tool inventory and an agent spending problem.

**2. Candidate redesigns, including their costs**

| Candidate                                                                                                                                                      | What it gains                                                                                                                                                                                                                                  | What it costs and what can still fail                                                                                                                                                                                                                                                                                                                             | Verdict                                                                                                                                                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Keep the inline judge, specialize in one workflow.** For example, only paid competitive-pricing research.                                                    | Least disruption. Richer trusted task fields and matched legitimate/off-task purchases could establish a real semantic contribution.                                                                                                           | You still need to beat a well-configured task/operation policy at comparable review burden. False approvals still spend. A more descriptive catalog improves accuracy while increasing curation. Broad independent validation is the expensive part, not another prompt revision.                                                                                 | A viable continuation if real results are unusually strong. I would expect a better high-70s/80s submission before I would expect 90+. Do not assume model-based novelty deserves points by itself.                      |
| **Human-approved purchase plans; deterministic runtime enforcement.** A model may draft a narrow plan, but only a human activates its permissions.             | A checkable security boundary: compromised workers cannot expand the approved purchase set. Existing exact grants, reservations and durable payment records become the core. The model has a useful, measurable role in reducing setup effort. | Requires a comprehensible approval UI, complete parameter binding, quantity limits, versioning and correct enforcement on every execution path. Humans can approve an overly broad plan. An injected worker can waste authorized purchases or return a bad report. It can look like a permission editor unless usability and integration are demonstrably better. | **Recommend this.** It fits the existing code and replaces an unprovable task guarantee with explicit delegated authority. It earns 90+ only with product and evidence work, not through the architecture diagram alone. |
| **Merchant-provided typed manifests and signed quotes, with operator admission.** Turn the catalog into reusable integration packages.                         | Can reduce repeated manual onboarding and bind operation versions, payees and typed parameters more explicitly. A merchant-facing integration kit could be a separate wedge.                                                                   | A signature authenticates the publisher; it does not establish that “pricing lookup” actually delivers pricing or deserves authorization. Blindly trusting merchant descriptions recreates the injection/trust problem. Requires publisher adoption, version/revocation rules and compatibility work.                                                             | Useful later as an onboarding mechanism for the recommended design. Not a one-day replacement for trusted semantics, and not a security result by itself.                                                                |
| **A controlled execution environment for the whole research job.** Put paid and free tool calls behind a broker, record provenance and enforce workflow steps. | Could address free-request exfiltration and verify that reports actually use acquired evidence. Moves the product toward controlled agent execution rather than just payments.                                                                 | Requires reliable isolation, network policy, tool mediation and a larger threat model. A sandbox does not decide which purchases serve a task. Keeping an agent inside a container is not proof that every escape channel is closed.                                                                                                                              | Too large for the remaining day. Pursue only if users need the broader environment enough to accept its deployment burden.                                                                                               |

My recommendation is the second design, with a narrow target: **developers operating recurring research agents over a few known paid APIs**. Start with a competitive-pricing refresh and a historical-pricing analysis. These need different permissions at the same merchant, and both produce a deliverable someone can inspect. This target makes catalog maintenance explicit and amortizable. “Every enterprise agent wallet” does neither.

The sharper claim is:

> A human approves an exact purchase plan. The worker receives only authority to execute that plan. Even if the worker follows malicious instructions, it cannot expand the permitted operations, subjects, quantities or spending limits through this gateway. A model can draft the plan; it cannot activate or enlarge it.

This is an enforcement claim under stated trust assumptions, not a guarantee that the plan captures all human intent. The gateway, operator and admitted service definitions remain trusted. Authorization does not guarantee merchant honesty, data quality, report quality or protection of traffic outside the gateway.

**3. What the recommended architecture actually changes**

Do not merely rename mandates “plans” and keep the current judge-approval path. That would preserve the same authority model.

1. **Move semantic assistance to setup.** Use the trusted human task and operator-approved catalog to propose structured permissions. Show the proposed operations, subjects, options, counts, maximum spend and expiry before activation. Unknown or ambiguous requirements remain unresolved until a human chooses. Keep merchant pages and worker explanations out of this drafting channel. A failed draft must not activate a permissive default.

2. **Make the confirmation precise enough to inspect.** “Research Acme” is not a purchase permission. A pricing-refresh plan could authorize `GET /v1/pricing/{company}` for the five named companies, `period=30d`, one purchase per company, a fixed per-call cap and a fixed total. A history plan could separately authorize `POST /v1/pricing/export` once. The current [export description](catalog/catalog.json) says **all tracked companies**: the UI must reveal that scope, not imply the export is restricted to the five subjects. A greeting plan has an empty purchase set.

3. **Bind the stored authority completely.** Associate each permission with tenant, mandate, immutable plan revision, catalog revision, origin, payee, method, endpoint, exact subject set, allowed option values, per-subject/operation counts, amount limits and expiry. Bind request-body fields if they can affect the purchase; reject unsupported bodies instead of ignoring them. Preserve numeric and boolean meaning. The rendered confirmation must be derived from the exact structured object that is activated. A hash provides identity, not evidence that the human understood it.

4. **Enforce the plan before contact and again before signing.** Reject off-plan routes or parameters before quoting; verify the returned payee, asset, network and amount against the plan and hard rules. Reserve both spending and purchase allowances atomically. A retry with the same durable purchase identity must not consume another allowance or create another authorization. Concurrent fresh keys must not evade the one-purchase limit. Keep unknown settlement outcomes reserved. The existing [funds code](apps/gateway/src/db/funds.ts), [idempotency layer](apps/gateway/src/pipeline/idempotency.ts) and [payment store](apps/gateway/src/db/payment-store.ts) are foundations, not proof that these new count constraints already exist.

5. **Remove alternate sources of authority.** Disable role-wide standing grants and automatic judge-issued expansion. A runtime model may advise or tighten policy, but cannot approve outside the activated plan. Human review of an exception must show and activate a specific amendment, not bypass a failed scope check through a generic “Approve” button. Bind resumptions and cached grants to the approved revision; invalidate stale permissions when it changes. Recheck revocation before signing. Already-issued payment authorizations remain subject to their validity window; closing a plan cannot magically recall a signature already delivered. Audit the [grant logic](apps/gateway/src/pipeline/policy.ts) and [human continuation paths](apps/gateway/src/pipeline/index.ts), not just the main request handler.

6. **Deliver the thing purchased.** Persist a bounded merchant result independently of immediate settlement visibility, expose it under the chosen settlement policy, and return it as untrusted data to the worker. Show the finished report with its data sources and purchase receipts. The present [worker loop](apps/agent/src/loop.ts) returns only payment status to the model, and [payment delivery](apps/gateway/src/payments/pay.ts) can lose a received body while settlement remains unknown. Both must change. Recovery can preserve a body durably received by the gateway; recovering one never received also requires merchant replay/retrieval support. Do not promise universal delivery merely because a chain transaction exists.

This design does not need the invented trust score to establish its main claim. Remove the trust graph from the headline demonstration. Plan authority, remaining purchase allowances, real receipts and unresolved payments explain the product more clearly.

The residual attack is worth stating explicitly: if the plan authorizes five lookups, a compromised agent may consume those five lookups uselessly. Tight quantities bound that waste. They do not make it disappear. A stale or overbroad plan is a policy-authoring failure, even when the gateway enforces it perfectly.

**The novelty test becomes harder and more honest:** deterministic permissions are not new. Your distinctive contribution would be a low-friction way to turn real agent jobs into inspectable purchase permissions, then execute them with reliable x402 accounting and delivery. If users can configure the same safe permissions just as quickly using an ordinary form, the model has not earned its place. Keep the simpler interface and accept the lower novelty score.

**4. What a 90+ submission must show**

**The stage demonstration**

Within the three-minute format discussed in Part 1, I would want this sequence, supported by an uncut recording:

| Time      | Demonstration                                                                                                                                                                                             | Evidence a judge can inspect                                                                                                                                                                                                                                              |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0:00–0:30 | A target user starts a pricing-refresh job and approves its concrete purchase plan.                                                                                                                       | Real task input, exact scopes/counts, bounded spend, actual activation in gateway state. Any model-generated draft is visibly a proposal.                                                                                                                                 |
| 0:30–1:10 | A live worker buys admitted data and produces a short sourced comparison.                                                                                                                                 | One real x402 payment through the gateway on Base Sepolia, a transaction receipt tied to the decision, returned data, and its use in the report. Clearly label testnet and which merchants are team-controlled.                                                           |
| 1:10–1:55 | Inject a page that tries to turn the refresh into a historical export at the same allowed merchant, below the spending cap. Then show the same export permitted under a separately approved history plan. | Actual worker tool calls, the precise plan mismatch, no payment authorization for the denied request, and a successful legitimate control. Both tasks must allow the merchant and the role must permit exports; otherwise a simpler role restriction explains the result. |
| 1:55–2:25 | Drop the gateway reply or restart after durable response capture; retry the same purchase.                                                                                                                | One logical purchase, one settled authorization, no additional allowance consumed, and the same deliverable recovered. A clearly labeled recording is acceptable if waiting for reconciliation would consume the slot.                                                    |
| 2:25–3:00 | Let the judge alter the attack or purchase parameters; show the comparison results and residual limits.                                                                                                   | A genuine challenge and an inspectable record of what happened. The judge may try a fresh key, another company, option changes or plan reuse. A failed attack is one observation, not a universal proof.                                                                  |

If the live worker refuses the injection itself, say so. That demonstrates worker resistance, not gateway protection. Use a separately labeled direct compromised-worker request to exercise the gateway boundary. Do not silently replace the live model with the [scripted rehearsal](apps/agent/src/rehearsal.test.ts) and call it an induced attack.

Do not claim the plan checker has beaten deterministic authorization: it **is** deterministic authorization. On stage, the weak cap-only comparison motivates the problem; the strong manual-plan comparison establishes whether your product makes the solution easier to use. A category policy that bans all exports loses legitimate history work, but a manually configured per-task policy should match your enforcement. Your remaining advantage must be measured setup effort, usable integration or reliable execution.

**The evidence behind the stage**

These are my proposed thresholds for a 90+ assessment, not official CalHacks requirements and not results this repo has achieved.

| Question                                    | Evidence I would require before giving near-full credit                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Can it enforce the permission boundary?** | At least 100 distinct adversarial scenarios spanning scope changes, option/body changes, fresh-key repetition, cross-plan reuse, concurrency, catalog changes, revocation and review/resume paths. Zero observed out-of-plan signatures or settlements; show both denominators. Include an adversary that directly controls requests, so failure to inject the worker cannot inflate protection. A single reproducible boundary bypass prevents the proposed security score until fixed and re-evaluated. |
| **Does legitimate work finish?**            | At least 50 independently specified legitimate workflows, including permitted exports and borderline tasks, across more than one agent integration and more than the original demo templates. Aim for at least 95% useful task completion and no more than 5% needing an additional human interruption after initial plan approval. Report initial approval effort separately, plus wrong denials, plan amendments, missing data and failed deliverables.                                                 |
| **Does the drafting model help?**           | Compare manual per-task permissions, model-drafted human-approved plans, and the original inline judge on the same intended tasks. Aim for at least a 50% reduction in median setup time versus the strong manual baseline, without increasing unsafe permissions that humans mistakenly approve. Publish draft errors and human corrections, including omissions. A perfectly enforced bad plan remains an unsafe setup result.                                                                          |
| **Would anyone integrate it?**              | Five to ten target developers outside the implementation team complete timed setup and tasks without coaching. At least one integrates an additional service beyond the team's original fixtures. Record integration time, needed support, repeated use and reasons for rejection. Do not count teammates, applause, wait-list clicks or a staged sponsor conversation as adoption.                                                                                                                       |
| **Are the costs defensible?**               | Report cold setup and warm execution separately; median and p95 policy overhead, quote latency, settlement delay, total task time, model tokens/cost and review time. A reasonable runtime target is p95 policy overhead under 50 ms on a named deployment, excluding merchant/chain time. Show cost per completed task and saved operator time. “Zero runtime judge calls” is a design property; it does not mean setup is free.                                                                         |
| **Does it recover honestly?**               | Fault injection at reservation, signing, submission, response persistence and reconciliation, including concurrent retries and restart. Publish remaining held funds, settlement outcomes and deliverable availability. Any paid-but-lost result must be visible as a failure, even if budget accounting is correct.                                                                                                                                                                                      |
| **Is the evidence reproducible?**           | Freeze code, catalog, plan schema, model/prompt and labels before evaluation; record hashes, environment, commands and all outcomes. Preserve the [existing benchmark](eval/REPORT.md) as historical evidence. Keep attack induction, authorization, human approval errors and settlement/delivery metrics in separate tables. Three model runs describe variability, not three times as many independent tasks.                                                                                          |

One hundred related requests do not establish a production failure probability. Report scenario families and clustered variants instead of disguising permutations as breadth. Include confidence intervals where sampling assumptions make sense, and explicitly avoid treating adaptive attempts as independent random samples.

**Independent and adaptive attack testing must be real.** Give at least two people who did not build the policy or prompt the frozen implementation, documented limits and a fixed attack budget. Let them inspect failures and adapt subsequent attempts. Test both the ordinary worker and direct request control. Their targets should include the approval UI, confusing plan drafts, quantity accounting, request equivalence, stale permissions and allowed-but-wasteful purchases, not just English “ignore instructions” strings.

Keep development attacks separate from a final unseen evaluation. Publish total attempts, feedback available, attack families, successes, unresolved failures and dollar exposure; sanitize secrets, not embarrassing outcomes. If you patch after a successful attack, report the original failure and a new version's results. A teammate session is useful tomorrow; it is not independent red-team validation. One judge-authored injection is an excellent demo moment and a very small evidence set.

**Real integrated payment is mandatory for the proposed 92.** The test is the actual operator → agent → gateway → quote → authorization → merchant → chain → purchased data → report path. The [standalone payment milestone](apps/gateway/src/payments/STATUS.md) is not that path. Complete [J2b](docs/open-issues.md), including destination classification and pinned transport on both quote and paid requests, and remove the [live-path block](apps/gateway/src/main.ts) only after verification. An exact admitted HTTPS merchant is enough for the first integration; broad discovery is unnecessary.

Record the decision and payment identifiers, payee, amount, authorization identity and settlement transaction in one trace, plus the returned-data digest. Verify chain evidence rather than trusting a merchant success header. Run repeated successful purchases and a genuine recovery case. Keep simulated fault tests labeled separately from live-chain runs. Testnet settlement is a real integration demonstration; it is not evidence of customer revenue, mainnet readiness or commercial adoption.

What makes this worth 90+ is the combination: a useful external user workflow, an explicit authority boundary, a strong comparison, adversarial examination and working payment/delivery. A good explanation of why that combination would be valuable does not earn the points.

**5. What fits in the remaining day**

**Do not attempt the complete redesign tomorrow. Ship a narrow, honest slice.** Assume four people can each provide roughly 12–14 focused hours, or 48–56 person-hours. That is an optimistic capacity assumption, not 24 uninterrupted engineering hours per person. The estimate below includes the essential Part 1 repairs for this slice; it is not work to add on top of the entire Part 1 plan.

Use two explicit templates: “pricing snapshot for these companies” and “one full historical export.” A simple human-configured plan is an acceptable first implementation. Add model drafting only if one verified live call and the approval boundary already work. Describe template selection as template selection; do not advertise a general task compiler.

| Lane                                  | Concrete deadline deliverable                                                                                                                                                                                                                                                                                       | Person-hours |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -----------: |
| **Gateway/permissions owner**         | Freeze the two plan contracts with the UI owner. Bind exact subjects/options and one-purchase quantities; enforce merchant selection, remove standing/judge expansion paths, and verify retry, concurrency, expiry and human-review behavior. Keep one immutable catalog revision for the demo; reject stale plans. |         8–12 |
| **Payments owner**                    | Complete safe transport for one merchant, settle through the actual gateway, persist received results before settlement resolution, and exercise one delayed-proof/retry recovery. This is the most uncertain lane.                                                                                                 |        10–14 |
| **Product/agent owner**               | Wire the actual dashboard create/approve/close operations with authenticated operator access and correct agent IDs. Render the exact plan, return purchased data to the worker, display its report and provide the injected page. Recover visible state after refresh.                                              |         9–12 |
| **Evidence/demo owner**               | Freeze 6–10 matched task pairs plus targeted enforcement regressions. Run strong manual-plan and category baselines; measure any real model used. Arrange a bounded attack session with another team if available, time a few outside users, and keep all outcomes.                                                 |          7–9 |
| **Shared integration and submission** | Verify the full flow, review the permission/payment seams, build the dashboard, record the honest modes and limitations, rehearse and prepare the final evidence table. Protect the last three wall-clock hours for this.                                                                                           |          6–8 |
| **Total**                             | A small slice with almost no slack at the high end.                                                                                                                                                                                                                                                                 |    **40–55** |

The practical gates are more important than the estimates:

- **First two hours:** choose the two templates, agree their exact stored representation and enforcement path, and demonstrate one real provider call if claiming model assistance. In parallel, the payment owner must establish whether J2b can land in time. Freeze scope after this.
- **By roughly hour six:** require an actual create-plan → allowed purchase → data-backed report, plus an off-plan request stopped by the same gateway. If the redesign has not reached that state, stop expanding it and complete the Part 1 vertical flow.
- **At least six hours before submission:** require a safe integrated settlement path or select the labeled simulation fallback. Do not spend the recording window removing a transport gate and hoping.
- **Last three hours:** freeze behavior, rerun affected checks, capture the real results and record. Do not improve the model or labels after seeing the final attack results and still call them held out.

With three people, 40–55 person-hours leaves inadequate integration slack. Cut model drafting, extra templates and UI polish first. Preserve explicit authorization, useful output and honest evidence. If safe real settlement remains unfinished, keep the gate and take the score reduction. A mocked transaction cannot be repaired by more persuasive narration.

**My deadline judgment:** 90+ is not realistically reachable from this starting state in one day. The limiting work includes independent evidence, usability comparison and integration experience that a team cannot credibly manufacture overnight. Under exceptional execution, the narrow purchase-plan slice plus safe integrated payment, a useful report, strong controls and a small outside evaluation could reach **84/100**. That is an optimistic maximum I would presently defend, not the expected result. Completing only the original repair plan remains roughly **78**. An otherwise strong but simulated-payment version belongs around **72–76**, depending on how much of the new boundary and usable workflow is actually demonstrated.

The deadline pitch should be:

> Our research agent can buy only the operations and quantities a human approved for this job. Here it completes a paid pricing report. Here a compromised worker tries to expand the purchase and the gateway refuses. Here the authorized history job can make that purchase. We show the receipt, the delivered data and what happens on retry. These are the measured results for our small evaluation; arbitrary merchants, production readiness and universal injection resistance are outside this demonstration.

If model drafting is implemented and its time savings are measured, add that specific result. Otherwise leave it out. Retiring the “LLM understands why” headline is better than keeping a claim your strongest baseline invalidates.

**Post-hackathon, if users actually want it:**

- **First 1–2 weeks:** complete general typed plan validation, per-operation/subject quantity accounting, versioned amendments, revocation/resume behavior and all payment-delivery failure cases. Add reusable integration packages and at least one outside agent integration. Treat these as estimates contingent on the narrow slice working.
- **Following 2–4 weeks:** recruit target developers, compare setup against manual permissions, test recurring cold tasks and measure support/review burden. Build the plan-drafting model only as far as it improves those outcomes. Stop if users prefer a small deterministic template form and do not value the rest.
- **After a stable freeze:** run independent adaptive testing, hold back genuinely unseen tasks, and publish failures and revised evaluations. Harden deployment, operator authentication, key handling, service-change management and recovery before any production-money claim. Third-party service behavior and user adoption may take longer than the engineering schedule.

These are the activities that could justify 92. They cannot be counted as accomplishments in the hackathon submission because they appear on a roadmap.

**6. Per-criterion score for the recommendation**

Same weights and criteria as Part 1. The rightmost score assumes the full recommended design, the independent evidence described above, and an excellent demonstration. It is the score I would give that executed submission, not today's code or tomorrow's checklist. The one-day column assumes the smaller slice succeeds unusually well.

| Criterion                            | Part 1 repaired design | Best honest one-day slice | Recommended redesign, executed and validated well | Why the redesign earns the points; why it still loses some                                                                                                                                                                                            |
| ------------------------------------ | ---------------------: | ------------------------: | ------------------------------------------------: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Novelty, idea, practical application |                  11/15 |                 **12/15** |                                         **13/15** | A specific user and measured reduction in permission-setup burden create an application worth using. Capability-style authorization and payment proxies are established ideas; packaging them does not earn 15.                                       |
| Technical execution                  |                  17/20 |                 **18/20** |                                         **19/20** | Precise permission binding, atomic quantity/spend accounting, safe transport, durable delivery and recovery form a coherent implementation. Production deployment and service-change complexity remain.                                               |
| Working product and demo             |                  16/20 |                 **18/20** |                                         **19/20** | Independent users finish useful paid work, including permitted exceptions and recovery. The admitted-service model and constrained workflows still limit generality.                                                                                  |
| Measured evidence                    |                  11/15 |                 **12/15** |                                         **14/15** | Strong manual baselines, timed user work, unseen tasks, independent adaptive attacks and reproducible traces support the claim. A finite evaluation does not establish broad field reliability.                                                       |
| Security rigor                       |                  11/15 |                 **12/15** |                                         **14/15** | Runtime authority is explicit and bounded by code; adversarial testing covers alternative paths. Operators can still approve bad plans, merchants remain trusted for service meaning, and authorized waste/free traffic remain outside the guarantee. |
| Presentation and pitch               |                   8/10 |                  **8/10** |                                          **9/10** | The user, permission boundary, legitimate control, payment and deliverable are visible. The team explains residual limits without replacing the demo with caveats.                                                                                    |
| Sponsor-track fit                    |                    4/5 |                   **4/5** |                                           **4/5** | Integrated x402 and a demonstrated authorization contribution are concrete. No extra point for assumed sponsor eligibility or an unverified sponsor-specific requirement.                                                                             |
| **Total**                            |             **78/100** |                **84/100** |                                        **92/100** | **The extra points depend on a different authority model and stronger external evidence, not additional polish.**                                                                                                                                     |

I would withhold the 92 if the human merely approves vague prose, if a model or standing grant can still expand authority, if payments do not deliver usable data, or if the comparison avoids a competent manual-plan baseline. I would also withhold it if the “independent users” are teammates and the “adaptive testing” is another folder of authored fixtures. Those would reproduce the current ceiling under a new name.

## Part 3: the team's plan-lock proposal

**Keep plan-lock, Claude-assisted drafting, factual explanations and a demonstrable CDP signing backstop. Cut automatic scope expansion and the discretionary budget. Keep the in-plan anomaly judge out of the critical path until it beats simple rules. The full proposal adds enough ambiguity and unvalidated machinery to make it worse than the narrower Part 2 recommendation.**

I read the [entire proposal](design-docs/local/proposal-plan-lock.md), checked the implementation on `chunk3/phase8` at `3e75ddb`, and consulted Coinbase's current documentation and official SDK source on October 24, 2026. No live signing, settlement, model evaluation or sponsor conversation was performed for this review. Existing evidence and proposed acceptance tests are distinguished below.

A specific customer segment is **not** a prerequisite for this assessment. A general-purpose agent payment gateway can be a good hackathon submission. It still needs a concrete completed task and an intelligible benefit. I am not deducting points for lacking a named user base.

My projected scores are **80/100 for a well-executed one-day version of the feature-heavy proposal, 88/100 for its coherently bounded and fully evaluated version, and 85/93 for the strict version I recommend**. Part 2's comparison is 84/92. These are conditional judgments, not newly earned points. The CDP integration can add sponsor credit; contradictory permission semantics cannot.

**1. Novelty: plan-lock is a better boundary, not a new invention**

Yes, plan-lock can collapse into a permission editor. Exact allowlists, budgets, human approvals, recurring authority, risk-based review and isolated keys are established mechanisms. Combining them with a text box does not create a new security primitive.

The competitive baseline is stronger than the proposal admits. Ramp currently describes agent budgets, merchant restrictions, human approvers and x402 payments. Coinbase's x402 client documents per-payment and cumulative limits, network restrictions, and conservative reservation handling for ambiguous settlement. Those are direct overlaps with the spending-policy and accounting story. They do not establish that either product implements this exact task-to-operation workflow. They do invalidate “today the only safe way is to approve every payment.” [Ramp agent controls](https://agents.ramp.com/), [Coinbase x402 client configuration](https://docs.cdp.coinbase.com/x402/buyer/client-configuration).

| Proposed differentiator                            | What is actually distinctive                                                                                                                                                                                  | What I would demand before awarding novelty points                                                                                                                                                                                    |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Claude drafts plans from task text.**            | Potentially useful translation from human intent to inspectable API permissions, especially across multiple operations and parameter schemas. Natural-language policy generation alone is not a new category. | Show the exact structured draft, meaningful human correction, activated revision and enforcement. Compare time and permission errors against a good manual template/form. Generating plausible JSON earns almost nothing.             |
| **Trust scales friction.**                         | A product experiment about when to repeat human approval. The broad mechanism is conventional risk-based authorization.                                                                                       | Show fewer interruptions at comparable task completion and loss exposure, including an attacker that behaves normally before striking. A climbing score graph is not evidence of trustworthiness.                                     |
| **The judge gets code-capped discretion.**         | A bounded risk allowance for uncertain purchases. The cap is ordinary deterministic policy; the model adds uncertain selection within it.                                                                     | Demonstrate legitimate work recovered per unit of unauthorized/off-task spend and extra complexity. If all you prove is “the LLM can lose at most a small amount,” the idea has returned to the original capped-judge design.         |
| **Judge input excludes attacker prose.**           | A concrete architectural choice worth showing: the attacker can steer worker requests without supplying arbitrary instructions to the reviewer.                                                               | Inspect the actual projected input and test every new drafting/explanation/anomaly path. Canaries support a channel-exclusion claim, not universal model correctness or immunity to attacker-selected combinations of allowed values. |
| **Plan policy plus an independent signer policy.** | The strongest composition: task/HTTP constraints in the gateway, financially relevant signed-field constraints at a separate enforcement point.                                                               | Deliberately bypass the application check in a test and show CDP refusing a prohibited signature. Then show an allowed x402 purchase completing. An architecture logo is insufficient.                                                |

Frame it as **task-to-payment delegation with inspectable authority and two enforcement layers**. Demonstrate that the same ordinary-price purchase is permitted under one approved task plan and refused under another, while the model cannot alter either boundary. Then demonstrate the separate signer rejection.

Do not claim the deterministic checker “understands why.” Do not compare only with approving every payment or with a cap-only straw man. A manually authored plan should match your runtime enforcement and often match your approvals-per-1,000 result. Claude must earn its place through setup accuracy, time saved or useful explanations.

If drafting adds no benefit, keep the manually authored plan. Novelty drops, but the engineering and sponsor story can still be credible. Recover points through a visible independent signing boundary, useful purchased output and unusually convincing adversarial/recovery evidence. More discretionary autonomy is not the remedy for weak novelty.

**2. First fix the proposal's incompatible claims**

Three sentences cannot all be true:

- The agent cannot buy anything outside the human-approved plan.
- High-trust agents automatically gain another subject or a higher price cap.
- The judge can approve an off-plan purchase from a discretionary allowance.

They become consistent only if the original human authorization explicitly includes a larger, bounded envelope. Then the model is choosing inside that envelope; the displayed narrow plan is not the full permission boundary. Show the whole envelope to the human, including its maximum financial exposure. A notification after activation is not approval.

For tomorrow, use the simpler interpretation: **the activated plan is immutable; trust can add friction or suspend it; only explicit human approval changes its scope**. An approved recurring schedule can be reused, but it has a finite authorization horizon and aggregate limits.

Also reject “mostly a rename.” The [mandate creation route](apps/gateway/src/routes/mandates.ts) and [repository](apps/gateway/src/db/repos/mandates.ts) create an active database record and a hashed bearer token. They do not create a cryptographically human-signed purchase plan. The [schema](apps/gateway/src/db/schema.ts) lacks an explicit task-plan operation set, per-subject purchase counts and a parent recurring authorization with bounded child runs. [Standing grants](apps/gateway/src/pipeline/policy.ts) and judge approvals still supply authority. Existing mechanisms are reusable; the authority model is not already changed.

A cryptographic human signature is not essential inside the trusted gateway boundary. An authenticated approval of an exact, immutable structured revision is sufficient for the hackathon claim. Call it approval unless you actually implement and verify signing.

**3. Coinbase first: a real opportunity, with a narrower backstop than the pitch implies**

**What exists in this repository**

| Layer                   | Verified branch state                                                                                                                                                                                                                                                                                    | Consequence for the pitch                                                                                                                                |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Payer signing           | [Payment composition](apps/gateway/src/payments/index.ts) and [payment creation](apps/gateway/src/payments/pay.ts) use `privateKeyToAccount` and a local `walletPrivateKey`.                                                                                                                             | There is no CDP-enforced signing policy on this payment path today.                                                                                      |
| SDK dependency          | The [gateway manifest](apps/gateway/package.json) does not declare `@coinbase/cdp-sdk`. The [lockfile](pnpm-lock.yaml) contains version 1.59.0 transitively through another dependency; its installed signer adapter and policy types were inspectable.                                                  | A transitive package is not an integration. Add an explicit, pinned dependency if this path is built.                                                    |
| Real x402 milestone     | The [P2 status entry](apps/gateway/src/payments/STATUS.md) records transaction `0xbcf31d3f420dfd6006701912e015e935078a899bbd0f5bc0aeabedc0a41abb15`, block 49499677, for 10,000 atomic test USDC to PriceScope. It was made with the [standalone script](apps/gateway/src/payments/scripts/pay-once.ts). | Credit for a recorded protocol milestone, not for integrated plan-lock or CDP policy enforcement.                                                        |
| Integrated live mode    | [Startup composition](apps/gateway/src/main.ts) still refuses real quotes/payments pending pinned transport; [open issues](docs/open-issues.md) list the unfinished work.                                                                                                                                | The gateway cannot currently demonstrate the proposed live path merely by changing an environment setting.                                               |
| Merchant/facilitator    | [PriceScope](apps/merchants/src/pricescope.ts) provides one paid GET route and defaults to `https://x402.org/facilitator`. Its returned product prices are fixture data.                                                                                                                                 | Distinguish real testnet settlement, synthetic purchased content, the facilitator used, and the wallet signer. None implies the others are CDP services. |
| Accounting and delivery | [Reservations](apps/gateway/src/db/funds.ts), stored authorizations and [reconciliation](apps/gateway/src/payments/reconcile.ts) exist. The response-delivery defect and worker-data omission identified earlier remain in this revision.                                                                | Preserve the durable lifecycle during signer migration; a valid signature and transaction do not finish the product.                                     |

I could not independently reopen the transaction on Base Sepolia's explorer through the browsing tool. Therefore the historical payment is **verified as a repository record**, not freshly confirmed on-chain in this review.

**What current Coinbase sources support**

Coinbase's current buyer guide documents test-USDC payment on Base testnet using a CDP-managed wallet. Its client guide specifically provides `fromCdpEvmAccount` for attaching a CDP signer to an existing x402 client. That is the appropriate starting point for this code; replacing the whole pipeline with an automatic pay-and-retry fetch wrapper would risk bypassing its authorization and persistence sequence. [CDP buyer quickstart](https://docs.cdp.coinbase.com/x402/buyer/quickstart), [existing-client integration](https://docs.cdp.coinbase.com/x402/buyer/client-configuration).

The official policy schema supports `signEvmTypedData`, `evmTypedDataField` and `evmTypedDataVerifyingContract`. Typed-field criteria bind an EIP-712 type structure and compare message fields. Its transaction-value/`netUSDChange` criteria are not listed as typed-data criteria. This matters because the current exact-USDC path authorizes payment through EIP-712/EIP-3009 signing, not by having the gateway call a normal token-transfer transaction API. A policy on the wrong signing operation is not a ceiling on this path. [Coinbase policy schema](https://raw.githubusercontent.com/coinbase/cdp-sdk/main/typescript/packages/cdp-sdk/src/policies/evmSchema.ts).

The following is a proposed mapping, **not a deployed or live-tested policy**:

| Plan property                             | Independent CDP constraint to attempt                                            | What remains in the gateway                                                                             |
| ----------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Admitted merchant payee                   | Typed-data address condition on the actual authorization's `to` field.           | Merchant identity, URL/origin, endpoint, method and semantic catalog mapping.                           |
| Per-payment amount                        | Numeric condition on authorization `value`, expressed in atomic USDC.            | The approved quote, exact reservation, price-change policy and plan-specific cap.                       |
| Asset and message format                  | Verifying-contract restriction plus the exact emitted EIP-712 type/primary type. | Validate the full domain and network; separately prove any claimed signer-side chain restriction.       |
| Run/plan/daily total; purchase quantities | **No equivalent cumulative typed-signature control verified here.**              | Atomic durable accounting across requests, runs, retries and unresolved authorizations.                 |
| Subjects, options, task, catalog revision | Not encoded as such in the current transfer authorization.                       | Plan-lock must enforce and version them. CDP cannot infer the HTTP operation from the payee and amount. |

This mapping is my engineering inference from the schema and the local signing implementation. Validate actual field paths and primary type against a captured test payload; do not guess whether a policy path starts with `message.`.

**Do not confuse three different products or controls.** The x402 client's `spendControls` are explicitly documented as **client-side**. They are not an independent signer ceiling if the same process can omit them. CDP policy rules govern signing operations. The facilitator verifies/settles submitted authorizations; it is not your human-task checker. Coinbase's facilitator currently lists Base Sepolia `eip155:84532` support, but using it does not automatically attach wallet policies. [Client spend controls](https://docs.cdp.coinbase.com/x402/buyer/client-configuration), [CDP facilitator](https://docs.cdp.coinbase.com/x402/seller/facilitator).

“Coinbase caps it even if our code is wrong” needs qualification. A tested per-signature cap can reject one oversized authorization while still allowing many small ones. It does not independently enforce your $0.25/run allowance. Nor can it reject an off-plan endpoint that charges an otherwise allowed amount to an allowed payee. A fully compromised gateway with authority to change the CDP policy, export the key or use another signing route can undermine the claimed independence. Separate policy administration from the runtime credential where supported, test the separation, and state the remaining assumptions.

**Concrete CDP integration work**

1. **Prove the signer-policy combination first.** Provision a test account, attach a restrictive policy, fund it with test USDC, and exercise an allowed typed-data request and deliberate amount/payee/type/contract violations. Check actual signing rejection, not only a simulated policy result or local schema validation. Inspect project/account attachments, rule ordering, no-match behavior and alternate signing methods. Coinbase's SDK exposes distinct project/account policies and several signing operations; do not assume constraining one constrains all. [Official policy types](https://raw.githubusercontent.com/coinbase/cdp-sdk/main/typescript/packages/cdp-sdk/src/policies/types.ts).

2. **Inject a signer instead of a private key.** Refactor the boundary in [payments/index.ts](apps/gateway/src/payments/index.ts) and [pay.ts](apps/gateway/src/payments/pay.ts) to accept the CDP-backed signer/address. Update [main.ts](apps/gateway/src/main.ts) and configuration. Give reconciliation the actual payer address. Use the existing `ExactEvmScheme` path and explicit Base Sepolia/USDC selection; do not silently fall back to local-key signing if CDP refuses or is unavailable.

3. **Preserve one logical purchase and durable authorization.** Keep reservation before signing, persist the returned authorization before sending, and replay the stored authorization on transport retry. Examine the new remote-signing timeout window and prevent concurrent recovery from treating a retry as a fresh spend. Keep signature material gateway-private. A remote SDK migration must not undo the existing ledger protections.

4. **Complete safe transport and delivery.** Finish J2b on quote and paid requests for one admitted HTTPS merchant; preserve received response data across delayed reconciliation and restart. Feed purchased data to the worker and display its final output. This is prerequisite work even if CDP integration succeeds independently.

5. **Make the backstop visible.** Present the attached policy identifier/configuration, the actual signer rejection, a permitted gateway purchase and its settlement receipt linked to the decision and returned result. Demonstrate the gateway refusing a small off-plan request that the wallet's coarse financial policy would otherwise permit. This proves the two layers have different jobs.

6. **Choose the facilitator deliberately.** If using CDP's hosted facilitator, wire its authenticated client into the merchant and verify the supported network. If keeping the test facilitator, identify it correctly. The current docs support an authenticated CDP facilitator integration; they do not establish the hackathon sponsor's preferred deployment. [Facilitator integration](https://docs.cdp.coinbase.com/x402/seller/facilitator).

The current event page lists a Coinbase x402 prize. It does **not** provide enough detail to verify that CDP Server Wallet is mandatory, or which facilitator wins sponsor credit. Those are sponsor-specific questions, still unanswered in [the team's notes](demo/SPONSOR-NOTES.md). I would require the CDP backstop to award credit for **your claimed CDP backstop**, not pretend it is a published eligibility rule. [Cal Hacks prize listing](https://cal-hacks-13-0.devpost.com/).

Several older Coinbase policy-documentation URLs returned errors or empty navigation during this review. Current buyer/facilitator pages and official SDK source were reachable; installed SDK types corroborate the typed-data primitives. I could not verify a live policy in your account, runtime credential restrictions, a signer-enforced cumulative x402 run limit, signer-side chain-ID coverage, or sponsor-table guidance. Those gaps are explicit acceptance gates, not permission to claim the broad ceiling.

**Other tracks**

- **Anthropic:** Claude drafting a plan, helping a human correct it, and explaining an escalation is a defensible model role. Show live structured output, an actual correction and the measured tradeoff against a manual form. A generic explanation generator is weak sponsor work. Anthropic is named on the event page, but I could not verify a detailed Anthropic prize rubric there; do not equate the proposal's phrase about knowing Claude's limits with an official criterion.
- **Hyphenate:** The listed finance-autonomy track is a plausible fit. Demonstrate work proceeding without per-payment approval and a correctly handled exception. “Limited access” and “knows when to ask” are sensible framing, but their status as exact sponsor requirements was not verified.
- **Microsoft:** The event lists real-world/customer-impact awards. Useful output, deployment/recovery behavior and measured operator effort support that story. I did not verify an Azure requirement; do not add hosting churn just to display a logo.
- **Security:** The listed Armadin security award is relevant to a tested authorization boundary. A small independent attack session and an explicit failure case are stronger evidence than claiming zero attacks “by construction.”

These event-track observations come from the [current listing](https://cal-hacks-13-0.devpost.com/); the application recommendations are my judgment. No named customer segment is necessary to demonstrate the technical benefit.

**4. Component review: where the proposal weakens itself**

**Trust tiers: budget and renewal are authority decisions too**

“Trust never changes permissions” is too loose when trust unlocks more spend, more runs or new subjects. The defensible rule is that trust can never exceed an explicitly human-approved **maximum envelope**. Within that envelope, restoring a previously reduced allowance is possible, but it changes exposure and needs evaluation.

| Component                                | Harsh critique                                                                                                                                                                                                                                                                                                                | Recommendation                                                                                                                                                                                                                 |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Clean activity raises trust              | A compromised agent can cheaply make compliant purchases, avoid suspicious requests and then strike. “No escalations” measures absence of a signal, not absence of compromise. The current [trust update](apps/gateway/src/pipeline/policy.ts) rewards approved decisions, not independently verified useful task completion. | Do not unlock authority through payment count. For the demo, use explicit operator-enabled recurring mode and an incident pause. Describe thresholds as heuristics.                                                            |
| New agents get 25% of budget             | Twenty-five percent is arbitrary. A legitimate task needing 40% now fails despite having an approved plan. If “run” is freely restartable, four fresh runs can defeat the apparent restriction; unknown liabilities make reset behavior even more important.                                                                  | Cut it tomorrow. If retained later, compute an integer allowance against a defined parent budget, enforce cumulative exposure across child runs, and measure lost task completion.                                             |
| Auto-renew for established agents        | Reuse of an approved recurring permission is valid. Extending expiry or replenishing money indefinitely is new authority. A plan capped at $2 per run has unbounded lifetime exposure if the number of runs is unbounded.                                                                                                     | Human approval must include schedule, start/end, maximum run count/rate, per-run cap and overall/window cap. A durable scheduler issues run IDs; the worker cannot mint them. Outstanding reservations survive run boundaries. |
| High-trust price/subject adjustments     | “One more subject in the same category” directly conflicts with exact subject authorization. Repeated small increases can ratchet. Same category is not same permission.                                                                                                                                                      | Cut. Later, any adjustable set and absolute ceiling must be preapproved; compare to the original ceiling, not the last adjustment. If subjects are not enumerated or otherwise precisely bounded, ask a human.                 |
| One off-plan attempt suspends everything | This can limit exposure, but a malicious page can also cause denial of service and force approval spam. Legitimate requests for an amendment look off-plan too.                                                                                                                                                               | Suspend the affected run/session under a clear policy; rate-limit and deduplicate reviews. Do not automatically treat every malformed request, provider failure or legitimate extension as evidence of a malicious agent.      |
| Trust reset and cached authority         | A new identity/session, a cached grant or an in-flight continuation may escape a downgrade unless enforcement is comprehensive. Closing a plan cannot recall an already issued payment authorization.                                                                                                                         | Scope trust to durable identities; recheck status at final signing; invalidate permission caches by revision. Test concurrent downgrade/resume and explain the signed-authorization window.                                    |

The current [thresholds and deltas](packages/contracts/src/constants.ts) are not the proposed tier system: they govern grant use, judge routing, human routing and quarantine. They are bounded by a role baseline. A future recurring-plan demo is not already implemented merely because the dashboard can plot that score.

**Discretionary budget: cut it**

A $0.05/payment, $0.25/run allowance buys a more complicated product story and a larger state space for little demonstrated benefit. It requires an additional atomic ledger, run ownership, concurrency protection, unknown-settlement accounting, interaction with ordinary budget, grant rules and renewal rules. “Catalog merchant” does not mean “authorized for this task.” Several normal-priced purchases in this repository fit below $0.05.

If retained later, the human must explicitly approve that risk envelope. Its 50,000/250,000 atomic-USDC limits must be a **subset** of the parent authorized budget, not an unannounced addition. Reserve discretion and parent spending together. Never let a discretionary approval create a wider reusable grant. Count unauthorized task purchases as failures even when the discretionary ledger correctly caps them.

The claimed worst-case loss is $0.25 **per authorized run**, not $0.25 overall. Across `R` runs it is up to `0.25 × R` dollars before tighter aggregate limits; 100 such runs permit $25. If the worker can create runs, that advertised bound has no useful horizon. Cheap failed attempts can also consume model/transport resources outside the payment allowance.

There is a coherent later product here: “strict delegated permissions plus an explicitly purchased amount of model discretion.” That is a risk tradeoff, not zero off-plan authorization. It should win only if an ablation shows meaningful task completion gains with acceptable loss and operator cost. Do not add it for a more autonomous-sounding pitch.

The proposed **$5 attack is a poor headline**. It already exceeds the design's ordinary $1 role cap and dwarfs the discretionary limit. Show an off-plan purchase at the same normal amount as an allowed one, inside every coarse cap, and show why the plan boundary is decisive. In a separate discretion experiment, challenge the system with requests below $0.05 and with concurrent attempts to exhaust the run allowance.

**The in-plan judge: currently an unproven interruption generator**

Bursts and prices near a ceiling are measurable facts. Velocity thresholds, quantity limits and explicit price-change rules are sensible baselines. The [current input builder](apps/gateway/src/judge/input.ts) provides prior call counts and recent prices, but not a rich, timed history of recurring runs; numeric/boolean option projection also remains limited. “Unlike past runs” therefore requires new trusted telemetry, schema and evaluation, not just another sentence in the prompt.

A judge that only tightens can still cause false denials, extra review, latency and outages. Those directly damage the headline friction metric. “It cannot steal” is not evidence that it helps.

Run the anomaly model in shadow mode tomorrow if there is spare time. Compare **plan only**, **plan plus deterministic anomaly rules**, and **plan plus model**, holding plans, traffic and labels fixed. Report additional bad in-plan purchases stopped, legitimate work disrupted, review minutes and model cost. Do not manufacture suspicious examples that a two-line velocity rule already handles. Enable blocking only after evidence supports it.

For off-plan requests, a deterministic scope diff is the authoritative explanation. Claude can translate it into readable prose, but it must not invent a safe exception or decide whether a blocked catalog route becomes admitted. Keep a fixed factual display if explanation generation fails.

The proposal first describes two prompts and later retains an anomaly judge: that is **three distinct model roles**. Give each a separate input/output contract and evaluation. The existing [judge gateway](apps/gateway/src/judge/gateway.ts) rejects unknown routes, so an off-plan explainer needs a safe representation for unknown requests rather than forwarding raw URLs or merchant prose. Reuse the isolation principle, not an input builder whose assumptions no longer match its caller.

**5. Metrics that will survive questions**

**Plan-draft edit rate is not accuracy.** A dangerously broad plan can get zero edits because the operator misses the problem; a correct plan can be edited for taste. Measure authorization correctness against independently specified task requirements.

In the remaining day, use about **20 diverse tasks**, labeled before model execution by someone other than the prompt author. Include empty-purchase tasks, different subjects, permitted exports, ambiguous requests, strict quantities, price changes and recurring limits. Keep any tuning tasks separate. Three model runs measure stability across those 20 tasks, not 60 independent tasks.

Record:

- Schema-valid draft rate and unsupported/invented operations.
- Extra permissions, excessive limits and missing necessary permissions, separately.
- Unsafe drafts mistakenly activated after human review.
- Human edits classified by security relevance, plus drafting/review time.
- Useful task completion under the activated plan.
- Cost and latency, including failures and retries.

Use a manual template/form as the strong baseline; counterbalance task order where possible so reviewers do not learn the answer from the first interface. With only a few reviewers, present raw counts and times as a pilot. Do not call a teammate's favorable impression a usability study.

**Approvals per 1,000 payments is a useful secondary metric and a dangerous headline by itself.**

Define the literal metric as:

```text
approval_rate = 1,000 × human approval decisions / unique settled logical purchases
```

Count initial activation, renewals, amendments, exception approvals and re-approvals after suspension. Show a separate steady-state rate only if its excluded setup cost is also displayed. Do not count transport retries, polls or duplicated events as new purchases. If no purchases settle, the rate is undefined.

Alongside it report **all human interventions and minutes**, including rejections, corrections, failed setup and abandoned tasks. Otherwise a system that forces the human to reject every attack can claim low “approvals.” Include completed tasks, planned demand, denials, escalations, errors, outstanding payments and dollars spent outside intended task scope.

A static manual plan can also yield one approval for 1,000 routine payments. To demonstrate Claude's contribution, measure the work required to create correct plans and resolve changes. To demonstrate trust's contribution, compare fixed recurring authorization against trust-based review on identical jobs and attack schedules. A larger batch size alone reduces the ratio.

Tomorrow's honest evidence should have three clearly separated sets:

| Evidence set                                  | What it measures                                                                                                                                                                                        | What it cannot claim                                                                        |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| **Small live end-to-end set**                 | Actual model behavior, real gateway decisions, a few testnet settlements, returned data and final answers. Publish raw counts.                                                                          | Thousands of chain settlements or broad security confidence.                                |
| **Frozen authorization/attack set**           | Matched allowed/off-plan requests, direct compromised-worker calls, fresh-key concurrency, stale revisions, subject/option changes, repeat runs and pause/resume. Give successes and failures by layer. | Every blocked prepared request was induced by a prompt injection.                           |
| **Optional 1,000-purchase controlled replay** | Reservation throughput, repeat-run accounting and operator actions for that specific synthetic workload.                                                                                                | “1,000 real payments” if settlement is mocked, or a generally applicable intervention rate. |

For example, two approvals across 40 observed purchases normalize to **50 per 1,000**, not two. Display “2/40 observed; 50/1,000 normalized.” A thousand repeated operations under one fixed template mainly measure amortization. Include task changes and real exceptions, and hold workload mix constant between alternatives.

“Off-plan attack success is zero by construction” is premature. You need evidence that every signing route, cached grant, human continuation, retry and renewal consults the approved revision. The existing [evaluation](eval/REPORT.md) establishes neither that new invariant nor successful live injection. Preserve its historical labels and add a versioned plan-lock suite. Test tiny in-cap attacks; do not rely on the nine old variants stopped before the judge.

Have another team or an uninvolved person adapt attacks after a freeze. Preserve attempt counts and failures. Direct request attacks test the compromised-worker assumption; live page attacks separately test induction. If discretion is enabled, report strict-scope deviations and discretionary exposure explicitly rather than redefining every approved deviation as a successful block.

**6. Build order for roughly one day**

The highest score impact comes from making the permission boundary and purchased output real. Start the risky payment/CDP feasibility work immediately in parallel, even though it is not the first row of the product priority list.

Effort below is in **person-hours**, includes the relevant unfinished Part 1 work, and is not additive to Part 2's entire plan. Score effects overlap.

| Priority / score impact                       | Change and existing code                                                                                                                                                                                                                                                                                                                                                                                                  | Acceptance condition                                                                                                                                           |                                         Effort |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------: |
| **P0: necessary for any plan-lock claim**     | Add a minimal immutable plan with allowed operations, subjects/options, quantities, caps and expiry. Wire it through [mandates](apps/gateway/src/routes/mandates.ts), [schema](apps/gateway/src/db/schema.ts), [precontact](apps/gateway/src/pipeline/precontact.ts), [grants](apps/gateway/src/pipeline/policy.ts) and [continuations](apps/gateway/src/pipeline/index.ts). Disable standing grants and model expansion. | The same small request is allowed under one approved plan and blocked under another; cached/human/retry paths cannot escape. One simple pause state is enough. |                                       **8–12** |
| **P0: largest visible product gain**          | Wire real plan activation/review/close in the [dashboard](apps/dashboard/app/api/mandates/route.ts), fix agent identifiers/access protection, and return purchased bodies/final output from [the agent](apps/agent/src/loop.ts).                                                                                                                                                                                          | An authenticated operator activates the exact displayed plan, the agent buys useful data, and its report visibly uses it. No fabricated dashboard success.     |                                       **9–12** |
| **P0: essential x402 and reliability credit** | Complete pinned quote/paid transport in [payments](apps/gateway/src/payments/quote.ts), preserve responses in [pay.ts](apps/gateway/src/payments/pay.ts)/the payment store, and verify [fund reservations](apps/gateway/src/db/funds.ts) with quantity accounting and unresolved liabilities.                                                                                                                             | One HTTPS merchant settles through the gateway; delayed proof/retry recovers data without a second purchase. Keep the live gate until this passes.             |                                      **10–14** |
| **P0: prevents an unsupported submission**    | Add supplemental paired and boundary cases in [eval](eval/api/runner.ts), a small draft/manual comparison, intervention counters and a bounded outside attack session.                                                                                                                                                                                                                                                    | Raw counts, explicit modes, no denominator inflation, and at least one meaningful failure/limit discussed. Preserve the old report.                            |                                        **6–8** |
| **P1: strongest additional sponsor value**    | Add a CDP signer adapter and attached typed-data policy at [payment composition](apps/gateway/src/payments/index.ts); preserve reconciliation and retry behavior.                                                                                                                                                                                                                                                         | Allowed signing succeeds, prohibited signing is actually rejected by CDP, and the same signer completes a gateway purchase. No local fallback.                 | **4–7**, after credentials/account access work |
| **P1: retains the useful Claude role**        | Add a structured plan drafter and, if cheap, an advisory explanation path in [judge/](apps/gateway/src/judge/index.ts). Carry isolation and validation into separate contracts.                                                                                                                                                                                                                                           | Human sees exact permissions; cannot activate invalid drafts; unsafe overreach and edits are measured. Fixed explanations remain usable on model failure.      |                                        **3–5** |
| **P0: reserve explicitly**                    | Full-stack integration, affected checks, dashboard build, recording and rehearsal.                                                                                                                                                                                                                                                                                                                                        | One submitted state and a recorded truthful fallback.                                                                                                          |                                        **4–6** |
| **Total**                                     | Strict plan-lock, useful flow, evidence, CDP and limited Claude assistance.                                                                                                                                                                                                                                                                                                                                               | Fits only with parallel ownership and little rework.                                                                                                           |                                      **44–64** |

Four people at 12–14 productive hours each provide about 48–56 person-hours. The upper estimate does not fit. Three people need larger cuts. The CDP estimate excludes account-access delays and assumes the signer-policy spike succeeds; it is not a promise that migration is a four-hour task.

A minimal recurring demonstration can use a human-approved finite batch of runs under one parent authorization, with stable run IDs and total allowance. If that accounting cannot fit, demonstrate one run and label recurrence as future work. Do not simulate auto-renew by repeatedly creating fresh unrestricted mandates.

**Cut tomorrow:** learned trust promotion, the 25% tier, autonomous plan edits, discretionary spending, model-based anomaly blocking, merchant-manifest work, elaborate trust graphs, extra sponsor integrations and a general scheduler. Retain at most incident pause/re-approval and explicitly approved bounded recurrence. These cuts preserve the claim while removing several new ledgers and policy states.

**The 6 PM line must gate the real boundary, not just the drafting screen**

Treat 6 PM as October 24, local event time. Before it, independently prove:

1. The human-approved structured plan is actually the object checked on every payment path.
2. A matched allowed/off-plan pair works through the real dashboard/agent/gateway flow.
3. The payment lane has either passed safe integrated settlement or selected a labeled mock fallback.
4. CDP signing/policy enforcement is proven or removed from the submitted claims.

Run the CDP feasibility spike early, ideally in the first 60–90 minutes of its owner's work. Do not wait until 6 PM to discover that the policy does not constrain the relevant signing method.

If only Claude drafting or its UI is late, the hand-written-plan fallback is sound: an operator reviews a structured config, authenticates activation through the actual admin path, and records its revision. Keep that same enforcement object and ledger. This preserves security and loses some model/experience credit.

If enforcement itself is late, a hand-written plan does **not** rescue the claim. If payment transport is late, hand-written plans do not authorize removing the real-mode gate. If CDP fails, a verified local-key x402 integration may still be shown with truthful labeling, but it has no independent CDP signer ceiling. None of these fallbacks should masquerade as the full proposal.

After 6 PM, spend the remaining time on integration, paired cases, factual metrics and the recording. Do not spend it implementing the discretionary account or making the trust curve smoother.

**7. Demo and scores**

The clean demonstration has five beats:

1. Claude proposes a plan; a human sees and corrects an exact permission.
2. The worker completes a paid task under the activated plan.
3. A normal-priced, cataloged off-plan request is blocked while a matching authorized control succeeds.
4. A separate direct-signing probe is refused by the attached CDP policy.
5. A retry recovers the original purchase/result, and the metrics distinguish initial approval, ongoing interventions and actual settlements.

An injected worker that refuses the attack does not establish gateway protection; show a labeled direct compromised-worker request as well. A CDP rejection of a $5 payment does not establish task-relative enforcement; show the small off-plan case separately. A small paused-run demonstration is enough to explain friction without claiming you trained a reliable trust model.

For the table, **“team proposal”** retains the discretionary pool, anomaly judge and multiple trust tiers. Its fully evaluated column assumes the contradictions have at least been resolved by explicit human-approved envelopes and honest bounded-loss wording. The literal conflicting promises cannot all be validated. Even under the coherent interpretation, the extra features have weaker demonstrated differentiation and a harder safety/usability tradeoff than strict plan-lock.

**“Recommended strict version”** cuts those additions, keeps Claude as a proposal/explanation assistant, and proves the narrower CDP backstop. All CDP credit assumes actual signer-policy enforcement and integrated settlement; merely using a CDP account is insufficient.

Scores are shown as **one-day execution / fully validated execution**, with the same criterion weights as Parts 1–2.

| Criterion                            | Maximum |      Part 2 | Team proposal | Recommended strict version | Reason for the difference                                                                                                                                                                                          |
| ------------------------------------ | ------: | ----------: | ------------: | -------------------------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Novelty, idea, practical application |      15 | **12 / 13** |   **11 / 12** |                **12 / 13** | Trust and bounded discretion are familiar controls. Measured task-to-plan assistance and the two-layer demonstration are the distinctive contribution; no named user base is required.                             |
| Technical execution                  |      20 | **18 / 19** |   **17 / 19** |                **18 / 19** | More policy states increase one-day integration risk. Correct permission binding, safe signing and recovery matter more than feature count.                                                                        |
| Working product and demo             |      20 | **18 / 19** |   **17 / 18** |                **18 / 19** | The rich design makes approval, renewal, suspension and exception behavior harder to understand and finish. A clear successful task plus two distinct refusals is stronger.                                        |
| Measured evidence                    |      15 | **12 / 14** |   **11 / 13** |                **12 / 14** | Draft edit rate and approvals/1,000 alone are weak. Every additional adaptive policy needs an ablation and legitimate controls.                                                                                    |
| Security rigor                       |      15 | **12 / 14** |   **11 / 12** |                **12 / 14** | Discretion explicitly accepts task-relative mistakes; promotion/renewal enlarge the failure surface. Strict authority is easier to inspect, test and explain. CDP protects only the independently enforced fields. |
| Presentation and pitch               |      10 |   **8 / 9** |     **8 / 9** |                  **8 / 9** | Full credit requires one coherent claim, raw metrics and accurate separation of plan scope, risk allowance and signer limits.                                                                                      |
| Sponsor-track fit                    |       5 |   **4 / 4** |     **5 / 5** |                  **5 / 5** | Real x402 settlement plus an actual CDP policy rejection can justify the extra point Part 2 withheld. This is technical fit, not a guarantee of eligibility or a prize.                                            |
| **Total**                            | **100** | **84 / 92** |   **80 / 88** |                **85 / 93** | **Additional autonomy does not automatically improve the submission. A demonstrated independent signing layer can.**                                                                                               |

The fully validated scores require unseen/adaptive attacks, strong manual baselines, measured operator effort and recovery evidence beyond what this branch currently supplies. They do not require inventing a customer segment or claiming adoption. If the richer features later demonstrate substantial marginal benefit at comparable risk, I would reassess them; the proposal supplies no such evidence now.

**90+ is still not an honest one-day forecast.** An excellent strict implementation with verified CDP integration could justify 85; without the CDP proof, return toward Part 2's 84 rather than retaining the extra point. A hand-written-plan fallback loses drafting novelty and Anthropic strength but can preserve most security and payment credit. A mocked payment path remains materially below either ceiling.

The pitch I would accept is: **“Claude proposes the purchase permissions. A human activates them. Our gateway enforces the exact operations and quantities, and CDP independently rejects the prohibited payment signatures we demonstrate. The agent completes the work without approval for every payment.”** Do not add “even if our code is wrong” without naming which signer constraints survive that failure. Do not add “nothing outside the plan” while keeping a hidden route for the model to say yes.
