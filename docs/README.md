# docs

Shared documentation for the whole team: how the system fits together, what each chunk owns, how to run it, and what is still open. The design specs live in [`design-docs/`](../design-docs/); these pages describe the code as it is now.

**Start here:** [architecture.md](architecture.md), then the page for whatever you're touching.

| Page | What's in it |
|---|---|
| [architecture.md](architecture.md) | Every part of the system, who owns it, where its code lives, and a payment traced step by step |
| [status.md](status.md) | What each chunk 3 phase delivered, the open PR stack, and the merge order |
| [running.md](running.md) | Commands and environment for tests, the eval and the demo agent, including what needs a live key |
| [open-issues.md](open-issues.md) | Open decisions and remaining work, grouped by topic |

## Editing these docs

These pages are for everyone to edit. Keep them true to the code:

- **Change the doc in the same PR as the code.** If you move a file, rename a route or change a reason code, update the page that mentions it.
- **Link, don't copy.** Point to the spec in `design-docs/` or to the source file instead of restating it, so there's one place to update.
- **Add your chunk's details.** Chunk 3 wrote most of this; chunks 1, 2 and 4 should correct anything wrong about their parts and add what's missing.
- **Tick off [open-issues.md](open-issues.md)** when something is decided or done, and add new open questions there.
- **No secrets.** No keys, tokens or private wallet details, even as examples.
- Formatting is checked by Prettier (`pnpm run format`); relative links should resolve from `docs/`.

## Design references

- [Design](../design-docs/Design.md) and [contracts](../design-docs/final_contracts.md), the source of truth for interfaces
- Chunk specs: [1 payments](../design-docs/CHUNK-1-PAYMENTS.md), [2 gateway](../design-docs/CHUNK-2-GATEWAY.md) ([build plan](../design-docs/CHUNK-2-BUILD-PLAN.md)), [3 judge, agent and eval](../design-docs/CHUNK-3-JUDGE-AGENT-EVAL.md), [4 dashboard and demo](../design-docs/CHUNK-4-DASHBOARD-DEMO.md), [2/3 boundary](../design-docs/CHUNK-2-3-BOUNDARY.md)
- Chunk 3 decision records: [phase 4](../design-docs/CHUNK-3-PHASE4-DECISIONS.md), [phase 5](../design-docs/CHUNK-3-PHASE5-DECISIONS.md), [phase 6](../design-docs/CHUNK-3-PHASE6-DECISIONS.md)
- Evaluation results: [`eval/REPORT.md`](../eval/REPORT.md); demo agent: [`apps/agent/README.md`](../apps/agent/README.md); payments status: [`apps/gateway/src/payments/STATUS.md`](../apps/gateway/src/payments/STATUS.md)
