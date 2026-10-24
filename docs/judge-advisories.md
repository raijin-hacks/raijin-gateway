# Drafting and escalation explanations

Import from `apps/gateway/src/judge/index.ts`. These are separate advisory interfaces; the existing judge, admission rules and auth are unchanged. No dashboard/route/pipeline integration is included.

Chunk 2/4 must authenticate the human **before** calling the drafter. Supply the human's task text and the operator-approved catalog snapshot, never a worker transcript, URL, fetched page, quote/402 prose or merchant-supplied metadata. Shape validation cannot establish provenance. Catalog descriptions and mandate/policy text must come from the trusted operator store, not from a request claiming they are trusted.

```ts
const drafter = createPlanDrafter({
  model: 'claude-sonnet-4-5-20250929',
  apiKey: process.env.ANTHROPIC_API_KEY!,
  timeoutMs: 5000,
});
const proposal = await drafter.draft({ task: authenticatedHumanTask, catalog: approvedCatalog });
// Render proposal.draft and every proposal.unresolved item for review.
// null draft means requirements are unresolved; there is no usable mandate.
```

The strict `draft` shape is exactly the current `POST /mandates` fields minus operator-selected `agent_id`: `task`, `subjects`, `allowed_merchant_ids`, `budget`, `expires_in_ms`. Money is positive safe-integer atomic USDC; expiry is a positive safe-integer duration in milliseconds, starting at eventual mandate creation. Task must be unchanged. Merchant IDs must belong to the supplied catalog, with no duplicates. Unknown fields and invalid model output fail closed with redacted `JudgeError` codes. The prompt requires unknown budget, expiry, subjects or merchant requirements to stay unresolved rather than guessing. Schema validation cannot prove semantic fidelity to human intent; human correction and review remain necessary.

The envelope `{draft, unresolved}` is an advisory result, not a new purchase-plan contract. Human review is mandatory. Do not automatically submit it, treat `unresolved` as authority, create grants, or interpret successful drafting as activation. After human correction, Chunk 2 must revalidate against the current contract/catalog and bind the selected agent. Chunk 4 must show the exact fields that the real authenticated creation route will store. This API cannot demonstrate immutable plan revision activation; that belongs to Chunk 2.

## Proposed v1.3/v1.4 amendment for the Chunk 2 owner

The current mandate contract has **no endpoint allowlist, approved option-value map, per-payment cap, quantity limits, catalog revision or immutable activation revision**. Existing role caps and per-mandate grants are not human-approved operation-plan fields. No alternate contract is invented here. Every draft result includes the fixed unresolved schema-gap warning, and such extra draft fields are rejected. Endpoint/option/per-call requirements may be described in unresolved text for the human, but cannot be represented as executable permissions. The drafter therefore cannot meet strict plan-lock enforcement/activation acceptance until the owner accepts a contract amendment and supplies its validator. Do not claim exact endpoint/option drafting or enforcement from this implementation.

Proposed amendment: owner-defined operation/option restrictions and per-call caps, bound to an immutable authenticated revision and catalog version, with expiry/count accounting. Confirm storage and enforcement across approval, grants, replay and recovery before expanding the draft schema. No automatic scope expansion, renewal or discretionary budget is implemented.

## Explanations

```ts
const facts = buildExplanationInput(trustedGatewayContext);
const advisory = await createEscalationExplainer(config).explain(facts);
// Render as plain advisory text beside the existing authoritative decision/reasons.
```

This accepts sanitized `JudgeInput` facts, with a local extension for integer/boolean option values. Use `buildExplanationInput`, never raw request JSON. It starts with the existing projection, then adds only exact valid booleans and in-range safe integers from declared option parameters with one occurrence, matching kind and no violation. Zero and false retain their meanings. Existing subject/enum protections and the existing judge's projection remain unchanged. Unknown routes cannot reach either live model channel.

The explanation output has only `explanation` (at most 200 characters) and adapter-owned `source` (`model`, `stub`, `fallback`). It has no approval/decision/grant channel. Errors, malformed outputs, timeouts and outages return fixed review guidance with `source: 'fallback'`; malformed input throws before network. Generated prose is advisory, not verified proof of correctness: render it as text and never parse it for authority or replace authoritative mismatch reasons with it.

Use `createStubPlanDrafter()` and `createStubEscalationExplainer()` offline. Draft stub returns null with unresolved requirements; it never invents usable permission fields. Explanation stub describes numeric facts only.

Both real adapters use the unchanged allowlist/config validator and native fetch API-key auth. Their isolated transport applies the same one-request/no-retry, redirect rejection, 5 s maximum total deadline (including body reads), abort, 64 KiB response cap, UTF-8/envelope validation and redacted errors as `real.ts`. New input JSON is also capped at 64 KiB. Never silently retry or fall back to a fabricated draft. There is no change to gateway startup or the existing judge.

## Local live trial (costs an API call)

Prepare a UTF-8 task file containing the human's explicit task, subjects, budget in atomic USDC and expiry in milliseconds. Use only an operator-reviewed catalog file. With `ANTHROPIC_API_KEY` already set locally:

```sh
node --import tsx apps/gateway/src/judge/draft-cli.ts --live /tmp/human-task.txt catalog/catalog.json
```

The CLI pins `claude-sonnet-4-5-20250929`, requires credentials and `--live`, prints a labeled proposal only and never activates it. Do not commit credentials or task output containing private data. This change has no live-model results; successful API output, human edits and exact activation evidence still require a local run and Chunk 2/4 integration.

Verification: `pnpm exec vitest run apps/gateway/src/judge` covers old/new prompt isolation, typed options, strict schema/catalog validation, transport failures and complete deadlines. Root lint/format/typecheck/test/build remain required.
