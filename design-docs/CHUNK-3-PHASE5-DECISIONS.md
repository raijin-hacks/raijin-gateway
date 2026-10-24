# Chunk 3 phase 5: safe input builder and canary gate

PR 5 implements J3 in `apps/gateway/src/judge/input.ts`. All judge modes expose
this same builder; provider validation remains strict and receives only the
projected `JudgeInput`. Relative source imports use NodeNext `.js` extensions.

## Projection decisions

- Gateway composition must supply human-owned mandate/policy text and the trusted
  catalog objects from matching against the pinned catalog. The builder does not
  turn merchant response metadata into catalog policy or re-authenticate context.
- Reject unknown matches and method/endpoint mismatches with redacted
  `JudgeError('JUDGE_ERROR')`. PR 4's route gate still belongs before quote/grant
  routing; this builder is an additional boundary, not pipeline integration.
- Iterate own catalog parameter declarations. Never emit undeclared/forbidden
  names or values. Require exactly one matching occurrence; omit duplicates.
- Emit subject values only by selecting the original mandate string using shared
  trim/lowercase normalization. Emit enum values only by selecting an exact catalog
  member. A violation or mismatched parameter kind prevents value disclosure even
  after human approval. Retain declared subject/option names and kinds without a
  value when unmatched/invalid; omit integer and boolean values in all cases.
  Missing parameters are absent. No coercion or repeated URL decoding occurs.
- Explicitly copy trusted labels and constrained facts into fresh objects. Compute
  merchant selection from allowed IDs. Known matches have `url_shape: null`.
  Validate the result with the shared strict schema; numeric facts must be
  nonnegative safe integers. Context/schema errors never expose validation details.
  The result and adapter input are detached from caller-owned arrays/objects.

## Canary gate and limits

`input.test.ts` runs under the normal Vitest suite. It independently tampers raw
path/query names and values, parameter kinds/violations, extra nested fields,
agent/page text, merchant metadata, credentials, hashes, trust and session data.
It checks both serialized builder output and the real adapter's captured HTTP
request body while asserting trusted catalog descriptions remain visible.

The gate discovers existing held-out attack JSON fixtures, requires unique
nonempty canaries, and injects each canary at every tested untrusted location.
Only fixture identity/kind/canary are used: this is isolation testing, not prompt
tuning, attack replay, or an accuracy evaluation. No provider network calls occur.
Real catalog/canonicalizer/matcher tests also cover decoded subjects and unusual
parameters that could survive human review. Numeric boundaries, malformed contexts,
unknown routes, absent/duplicate/inherited declarations and mutation isolation are
covered separately.

The checkout still lacks the `/pay` orchestration described by PR 6. These tests
prove the builder/adapter boundary, not pre-contact ordering, durable human
continuation, SSRF, idempotency or production payment authorization. PR 4's proposed
boundary amendments and owner sign-off remain unchanged.
