# Frozen paper fixtures (v1)

`mandates.json` holds the three human-owned mandates. `cases.json` labels ten
legitimate and ten off-task cases before any model tuning. The endpoint descriptions
are curated paper catalog fixtures, not agent or merchant metadata, and do not
assert that these routes exist in the live catalog.

L1–L9 and M1–M9 contain sanitized JudgeInput objects. L10 and M10 are routing-only
fixtures with identical URL shapes: both must escalate without a judge call.
Report judge accuracy with denominators of nine legitimate and nine off-task;
report whole-system results separately with denominators of ten each.
L4 is legitimate because the pricing mandate explicitly requests that limited export.

Run `pnpm typecheck` and `pnpm test` without network or credentials after installing
dependencies. No real model results are claimed. The prompt, provider transport,
paper CLI and measured checkpoint belong to PR 2.

## Interface handoff

The shared `@apf/contracts` source files were imported from
`origin/feat/phase-1-contracts` at `c478250e1ea2b2203ecb31ba67656152d8a3e3e7`
using git show, without switching branches. These include the complete v1.1 types,
strict schemas, enums, constants and reason maps. The package exports TypeScript
source for this no-emit workspace rather than requiring a separate build.

Chunk 3 adds the missing JudgeInput schema and lowercase aliases for compatibility.
JudgeOutput validation uses Chunk 2's `JudgeOutputSchema` directly: grant money
and TTL must be positive safe integers, with no grant on denial/escalation.
Gateway clamping is still required. Approve plus an injection flag is preserved;
gateway precedence remains an open integration question.

`validatePaperFixtures` validates strict case/mandate schemas, unique IDs, labels,
known-route admission and mandate consistency before evaluation. It does not score
model behavior or make network requests.

`CatalogModule` describes boundaries only; there is no loader or matcher yet.
A named shared Canonical export and encoded-separator policy still require agreement
before PR 4. `createInjectedJudge` supplies a fake-provider seam, not real transport.
`createStubJudge` requires an explicit mode and validates through the same path.
Both expose JudgeModule; buildInput deliberately throws JUDGE_ERROR until PR 5,
so this scaffold cannot accidentally feed raw gateway context to a provider.

## Verification in the restricted workspace

Typecheck, ESLint and deterministic Vitest checks can run against locally cached
tooling. A normal and explicit offline pnpm install were attempted; downloading
the pinned pnpm executable failed because registry DNS is unavailable. A generated
lockfile and clean/frozen install remain unverified. No handwritten lockfile is supplied.
The 11 TODO tests describe later phases and are not phase 1 completion claims.
