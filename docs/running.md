# running chunk 3

Setup is in the [root README](../README.md): Node 22.13+, `corepack enable`, `pnpm install`, `cp .env.example .env`. Never commit `.env`.

## Checks (no network, no API key)

| Command | What it does |
|---|---|
| `pnpm test` | All tests, including `eval/` and `apps/agent` |
| `pnpm run lint` / `format:check` / `typecheck` / `build` | The same checks CI runs |
| `pnpm paper` | Paper checkpoint CLI (`JUDGE_MODE=stub-approve` for an offline run) |
| `pnpm eval:v13:offline` | Versioned v1.3 matched-pair and boundary evaluation; stub and stronger deterministic controls; mock payments |
| `pnpm eval:heldout-v2:offline` | Chunk 4's held-out v2 (8 PriceScope pairs); stub and category baseline; mock payments |
| `pnpm agent:rehearse` | Demo agent: legitimate flow and off-task attack, end to end, offline |

The payment and gateway-startup tests open local TCP sockets. They fail with `listen EPERM` inside the Codex sandbox; run them on your own machine.

## Gateway modes (`.env`)

| Variable | Values | Default |
|---|---|---|
| `PAYMENTS_MODE` | `mock` \| `real` | `mock`. `real` is blocked at startup until J2b is done. |
| `JUDGE_MODE` | `stub-escalate` \| `stub-approve` \| `real` | `stub-escalate` |
| `JUDGE_MODEL` | must be on the allowlist in `apps/gateway/src/judge/real.ts` | — |

**Watch out:** `.env.example` sets `JUDGE_MODEL=claude-sonnet-4-5`, which is not on the allowlist. The judge accepts only the exact IDs `claude-sonnet-4-5-20250929` and `claude-haiku-4-5-20251001`. Which model to use is an open decision; see [open-issues.md](open-issues.md#judge-credentials-and-model).

## Live runs (cost real money; run locally)

These call the Claude API and need network access and a key.

```sh
# three supplemental evaluation repetitions, mock payments; model pinned by the CLI
# Set ANTHROPIC_API_KEY securely in the local shell first.
pnpm eval:v13:live
pnpm eval:heldout-v2:live

# demo agent against a running mock gateway and pages server (see apps/agent/README.md)
PAYMENTS_MODE=mock MANDATE_TOKEN='…' AGENT_TASK='…' AGENT_MODEL='…' \
  ANTHROPIC_API_KEY='…' pnpm agent:live

# dashboard Worker lab (localhost :4010). Live panes need ANTHROPIC_API_KEY; compromised panes do not.
ANTHROPIC_API_KEY='…' pnpm agent:lab
```

Use a personal key only for the command itself. Don't save it in `.env` or paste it into issues or logs.

## Versioned supplemental evaluation

Use `pnpm eval:v13:offline` for current v1.3 rules and `pnpm eval:v13:live` with `ANTHROPIC_API_KEY` already exported for three credentialed repetitions of `claude-sonnet-4-5-20250929`. No `.env` loading, retries or stub fallback occurs. See the [frozen protocol](../eval/supplemental/v1.3-v1/README.md) and [offline results](../eval/supplemental/v1.3-v1/results/offline.md). Results JSON and Markdown go only under `eval/supplemental/v1.3-v1/results/`; live outputs are timestamped.

Chunk 4's replacement judge set is `eval/cases/heldout-v2`. Run `pnpm eval:heldout-v2:offline` or `pnpm eval:heldout-v2:live` the same way. Do not edit V1–V17 or retune the judge prompt from those misses. Summary: [heldout-v2 RESULTS](../eval/cases/heldout-v2/RESULTS.md).

The new suite verifies its manifest content hash before model use. Independent label review is pending. Six legitimate/off-task pairs vary only human task; four bypass/boundary cases must deny with zero judge calls. The stronger category baseline wrongly denies legitimate export work, and judge-only catches are measured against that baseline. Errors/unknown are failures. Nine missing plan-contract scenarios are blocked, excluded from executable denominators, and never reported as passing. Live numbers, actual human interventions/minutes, token/cost accounting and strict plan enforcement remain unmeasured. Synthetic action rates per 1,000 mock settlements are explicitly separate from observed human rates.

`eval/REPORT.md` and `eval/cases/` retain historical results and labels, including rules that have since changed. The legacy `eval:stub` command regenerates the historical report; do not use it to refresh supplemental evidence. The new CLI and tests assert that the historical report bytes remain unchanged. Neither suite proves worker induction, independently reviewed labels, real signatures/settlements, or useful task completion.
