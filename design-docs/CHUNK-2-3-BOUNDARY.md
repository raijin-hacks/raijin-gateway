# Gateway and judge boundary (Chunk 2 / Chunk 3)

Oct 23, 2026 · Status: proposal

`final_contracts.md` stays the source of truth. This doc explains how Chunk 2 and Chunk 3 split the work, where their code meets, and which contract changes we propose. Proposed changes go through `final_contracts.md` section 6 before anyone codes against them.

## In one line

**Chunk 2 decides and holds the money. Chunk 3 reports facts and gives opinions.**

Think of a bank teller and a fraud analyst. The teller (Chunk 2) handles every transaction, holds the money, follows the rules exactly and makes the final call. The analyst (Chunk 3) touches no money and remembers nothing; they answer two questions when asked: "what is this URL?" and "does this purchase make sense for this task?" Chunk 3 also builds the demo agent and the evaluation, which use the gateway from outside, like any other client.

## Who owns what

| | Chunk 2 · Gateway | Chunk 3 · Judge, catalog, agent, eval |
|---|---|---|
| Role | Runs the pipeline and enforces every rule | Provides stateless functions; measures the result |
| State | All of it: database, budgets, grants, trust, decisions, stream | None. The catalog is a read-only file |
| Code | `packages/contracts`, `apps/gateway/` (most), `apps/gateway/src/db/` | `catalog/catalog.json`, `apps/gateway/src/catalog/`, `apps/gateway/src/judge/`, `apps/agent/`, `eval/` |
| A bug here means | Money is lost or overspent | Off-task purchases get through, or good ones are blocked. Chunk 2's hard limits still cap the damage |
| Proves attacks | Caught by rules: A1, A4–A9, A11–A13, A16 | Caught only by the judge: A2, A3, A14, A17; plus the A10 canary |

## The rule that separates them

**Chunk 3 reports. Chunk 2 decides.** Every rule below follows from it.

1. Chunk 3 never returns a reason code that decides an outcome. It returns facts (`EndpointMatch`) or an opinion (`JudgeOutput`), and Chunk 2 maps them to reason codes.
2. Chunk 3 never sees the mandate's state: budget spent, grants, trust, history. Chunk 2 passes only what the judge may know, inside `JudgeContext`.
3. Chunk 3 never decides what a failure means. It throws; Chunk 2 denies.
4. The judge never sets a limit. It proposes one; Chunk 2 clamps it and creates the grant.
5. The judge never names a payee, endpoint, method or parameter. Chunk 2 takes those from the request and the quote.

## Where the code meets

| Function | Owner | Called by | Returns | What Chunk 2 does with it |
|---|---|---|---|---|
| `loadCatalog(path)` | 3 | 2, at startup and in the seed script | `Catalog`, or throws | Loads it into the `merchants`, `endpoints` and `standing_grants` tables. A throw stops the gateway from starting |
| `canonicalize(rawUrl)` | 3 | 2, pipeline step 3 | `{ ok: true, url, origin, path, query }` or `{ ok: false, code }` | On failure: deny `BAD_URL` or `DUPLICATE_PARAM` at the pre-contact stage |
| `matchEndpoint(canonical, method, catalog)` | 3 | 2, pipeline step 3 | `EndpointMatch` | Maps violations to `PARAM_NOT_IN_SCHEMA`; checks subjects against the mandate; applies `UNKNOWN_WITH_PARAMS` |
| `buildInput(ctx)` | 3 | 2, pipeline step 9 | `JudgeInput` | Passes it straight to `judge` and never edits it |
| `judge(input)` | 3 | 2, pipeline step 9 | `JudgeOutput`, or throws `JudgeError` | Approve, deny or escalate; clamps the grant; quarantines the session on an injection flag |
| `createJudge(config)` / `createStubJudge(mode)` | 3 | 2, at startup | `JudgeModule` | `JUDGE_MODE` selects which one |

Code that sits next to the boundary but belongs to Chunk 2:

- **Subject check.** `matchEndpoint` labels a parameter as a subject; Chunk 2 normalizes its value and checks it against `mandate.subjects`.
- **Building `JudgeContext`.** Payee facts come from the database; budget and expiry come from the mandate row.
- **Clamping and creating grants.** `max_per_call` is the minimum of the judge's value, the role's per-call cap, 2× the reference price and 2× this payment's price. `max_total` is capped at the remaining budget. Expiry is capped at the mandate's expiry.
- **Turning errors into denials.**

## One request, step by step

| Step | What happens | Owner |
|---|---|---|
| 1 | Authenticate the mandate token; load the mandate and session | 2 |
| 2 | Idempotency lookup | 2 |
| 3 | `canonicalize`, then `matchEndpoint` | **3** (Chunk 2 calls them) |
| 4 | Pre-contact rules, using the match result and the mandate | 2 |
| 5 | `getQuote`, the first network call | 1 (Chunk 2 calls it) |
| 6 | Tier 0 rules, ending with the atomic reservation | 2 |
| 7 | Trust routing | 2 |
| 8 | Tier 1 grant lookup | 2 |
| 9 | Build `JudgeContext`, then `buildInput`, then `judge` | 2 builds the context; **3** builds the input and runs the judge |
| 10 | Human queue if escalated | 2 |
| 11 | Log the decision, call `pay()`, update trust, publish stream events | 2 (and Chunk 1 for `pay()`) |

Inside the pipeline, Chunk 3 code runs at only two points, steps 3 and 9. Everything else is Chunk 2 or Chunk 1.

## Keeping attacker text away from the judge

```
raw request ──▶ Chunk 2: JudgeContext ──▶ Chunk 3: buildInput ──▶ JudgeInput ──▶ model
                drops the raw URL,          keeps a param value only if it
                purpose text, merchant      matched a mandate subject or is
                response and page content   from the catalog's fixed list;
                                            unknown URLs become lengths only
```

Honest caveat: `JudgeContext` is not free of untrusted text. Its `match` field carries the `EndpointMatch` result, which includes text taken straight from the URL:
- `params[].name` and `params[].value` on a known endpoint
- `origin` on an unknown one, which is the attacker's hostname

The comment on `JudgeContext` in the contracts says "every field here is trusted or non-text", which is not true for those fields. So `buildInput` is the **only** filter for them, and two tests guard it:

- **Chunk 3's canary test** runs `buildInput` on every attack fixture.
- **The pipeline canary test** in `TEST-HARNESS-PLAN.md` checks the exact text sent to the model.

Proposed fix: correct the comment in the contracts. Changing the type isn't necessary, since `buildInput` needs the raw values to compare against the mandate's subjects and the catalog's fixed lists.

## Errors at the boundary

| Situation | Chunk 3 | Chunk 2 |
|---|---|---|
| Malformed URL or repeated parameter | `canonicalize` returns `{ ok: false, code }` | Deny at pre-contact with that code; no network call |
| Parameter not declared, or fails its type or list | `violation: 'PARAM_NOT_IN_SCHEMA'` on the parameter | Escalate; hold with no quote |
| Subject parameter | Labels it `kind: 'subject'` | Value not in the mandate's subjects: escalate `SUBJECT_NOT_IN_MANDATE` |
| Invalid catalog file | `loadCatalog` throws | Gateway refuses to start |
| Model timeout or API error | Throws `JudgeError('JUDGE_ERROR')` | Deny `JUDGE_ERROR`; release the reservation |
| Bad JSON, unknown field or unknown reason code | Throws `JudgeError('JUDGE_INVALID_OUTPUT')` | Deny `JUDGE_INVALID_OUTPUT`; release the reservation |
| `buildInput` throws (a bug) | Throws | Deny `JUDGE_ERROR` (any throw counts); release the reservation |
| `decision: 'approve'` with a grant | Returns it, shape already checked | Clamp, create the grant, set the reference price on first approval, call `pay()` |
| `decision: 'escalate'` | Returns it | Mark the decision `pending`; send an `approval_needed` event; start the 10-minute timer |
| `injection_suspected: true` | Returns it | Quarantine the session (−30 session, −5 agent), whatever the decision says |

## Worked examples

| Attack | Chunk 3's part | Chunk 2's part | Caught by |
|---|---|---|---|
| A4: 500 USDC to an unknown wallet | `matchEndpoint`: unknown, no parameters | `PER_CALL_CAP` at Tier 0; the judge is never called | Chunk 2 alone |
| A16: unrelated company after the grants warm up | Labels `company` as a subject parameter | Value isn't in the mandate: `SUBJECT_NOT_IN_MANDATE`, no quote fetched | Chunk 2, using Chunk 3's label |
| A2: $0.40 "premium summary" from an unknown merchant | Judge: off-task, deny | Every rule passes; asks the judge; denies; trust −15 | Chunk 3's judge |
| A17: `POST /v1/pricing/export` after `GET` grants | Identifies the export endpoint ("bulk export"); judge says over-scoped | Grant misses on method and endpoint, so it calls the judge, then queues for a human | Both |

## Working independently until Sat midday

| Chunk 2 uses | Instead of |
|---|---|
| A stub `matchEndpoint` that treats every URL as unknown with no parameters | The real catalog functions |
| `JUDGE_MODE=stub-escalate` or `stub-approve` | The real judge |

| Chunk 3 uses | Instead of |
|---|---|
| Hand-written `JudgeInput` JSON in `eval/paper/` | The gateway building it |
| Nothing for the HTTP API until Sat midday | The running gateway |

The first real connection is the Sat midday checkpoint: the real `matchEndpoint` and `JUDGE_MODE=real` go into the pipeline.

## Gaps and proposed contract changes

### At the boundary (needs Chunk 2 and Chunk 3 to agree)

1. **`Canonical` is not defined.** `matchEndpoint` takes `c: Canonical`, but the contracts' section 5 doesn't define it. Proposal: `type Canonical = { url: string; origin: string; path: string; query: [string, string][] }`, the success shape of `canonicalize` without `ok`.
2. **Where `DUPLICATE_PARAM` and `BAD_URL` come from.** Chunk 2's task G5 says they come "from the match result's violations", but `EndpointMatch` only carries `PARAM_NOT_IN_SCHEMA`. They come from `canonicalize`'s failure result. Proposal: fix the wording in `CHUNK-2-GATEWAY.md`.
3. **Known merchant, unknown endpoint.** `JudgeInput` allows `merchant.known: true` together with `endpoint.known: false`. But `EndpointMatch` with `kind: 'unknown'` carries only `origin`, and `buildInput` has no catalog to look the merchant up in. Chunk 3's J3 task already tests this case. Proposal: add `merchant: CatalogMerchant | null` to the unknown variant. That also lets Chunk 2 run `PAYEE_SWAP` and the allowed-merchants check for new endpoints on known merchants.
4. **No way to test the real judge path with a fake model.** `createJudge` takes `{ model, apiKey, timeoutMs }`, so the only fakes are the stub judges. Those skip `buildInput` and output checking entirely. Proposal: add an optional `transport?: (req: { system: string; user: string; signal: AbortSignal }) => Promise<string>` to `createJudge`. Tests can then record the exact text sent to the model and script raw replies: bad JSON, unknown codes, delays.
5. **Trust change after a judge failure.** The design doc's trust table doesn't cover `JUDGE_ERROR` or `JUDGE_INVALID_OUTPUT`. Proposal: no change to trust, since a broken model is not the agent's behavior.

### Inside Chunk 2 (from the gateway review)

6. **Idempotency race.** Two concurrent requests with the same key can both get past step 2, both fetch quotes and both reserve. The `UNIQUE` constraint only stops the second decision row, which leaves an orphaned reservation. Proposal: claim the key at step 2 by inserting a `pending` decision row at stage `precontact`, then update it as stages decide. A request that loses the insert returns the winner's current state.
7. **`TENANT_DAILY` isn't atomic.** It's a read-then-write, so parallel calls can overshoot. Proposal: a `tenant_daily(tenant_id, day, spent_reserved)` row with a conditional update in the same style as the mandate reservation, done in the same transaction.
8. **Standing grants have no usage counter.** `standing_grants.daily_total` exists but nothing records use against it. Proposal: `standing_grant_usage(standing_grant_id, day, used_total)` with an atomic conditional update, like the grant-use statement.
9. **Resuming after a Tier 0 escalation.** `REFERENCE_PRICE` and `NEW_PAYEE_LIMIT` escalate before the reservation exists, and the x402 quote may expire within the 10-minute window. Proposal: on human approval, fetch the quote again. Deny unless the payee and amount are unchanged from what the human approved. Re-run Tier 0 with only the approved rule skipped, then reserve. Invariant 7 still holds, because the gateway signs the quote it just checked.
10. **Quarantined sessions.** `QUARANTINED` is a pre-contact code, but trust routing runs at step 7, after the reservation. Proposal: also reject at step 1 when `sessions.status = 'quarantined'`.
11. **What `VELOCITY` and `DUPLICATE` count.** Attack A8 expects both to fire on 50 identical calls. That only works if both count attempts (decisions that reached Tier 0, any outcome), not settled payments, because `DUPLICATE` blocks identical calls after the second. Proposal: both count Tier 0 decisions in the window, whatever the outcome.

### Housekeeping

12. The chunk files say "read `contracts.md`", but the file is `final_contracts.md`.
13. CI's Node job requires npm (`package-lock.json`, `packageManager: npm@…`), while the contracts specify a pnpm workspace. See `TEST-HARNESS-PLAN.md`, "CI".
14. `.env` is committed (`10f8059`) and missing from `.gitignore`. Its values look like placeholders today; untrack it before real testnet keys go in.
