# running chunk 3

Setup is in the [root README](../README.md): Node 22.13+, `corepack enable`, `pnpm install`, `cp .env.example .env`. Never commit `.env`.

## Checks (no network, no API key)

| Command | What it does |
|---|---|
| `pnpm test` | All tests, including `eval/` and `apps/agent` |
| `pnpm run lint` / `format:check` / `typecheck` / `build` | The same checks CI runs |
| `pnpm paper` | Paper checkpoint CLI (`JUDGE_MODE=stub-approve` for an offline run) |
| `pnpm eval:stub` | Full API evaluation with the stub judge and mock payments |
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

These call the Claude API and need network access and a key. They have not been run yet.

```sh
# three evaluation runs, mock payments
ANTHROPIC_API_KEY='…' JUDGE_MODEL=claude-sonnet-4-5-20250929 pnpm eval:real

# demo agent against a running mock gateway and pages server (see apps/agent/README.md)
PAYMENTS_MODE=mock MANDATE_TOKEN='…' AGENT_TASK='…' AGENT_MODEL='…' \
  ANTHROPIC_API_KEY='…' pnpm agent:live
```

Use a personal key only for the command itself. Don't save it in `.env` or paste it into issues or logs.
