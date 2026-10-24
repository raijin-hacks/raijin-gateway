guys please make sure to squash and merge

# calhacks-13.0

Agent Payment Firewall: a payment gateway that checks _why_ an AI agent is paying, against the task a human gave it, before anything is signed.

Design and tasks:

- [Design](design-docs/Design.md)
- [Contracts](design-docs/final_contracts.md) (the source of truth for interfaces)
- [Chunk 1: Payments](design-docs/CHUNK-1-PAYMENTS.md)
- [Chunk 2: Gateway](design-docs/CHUNK-2-GATEWAY.md) · [build plan](design-docs/CHUNK-2-BUILD-PLAN.md) · [Chunk 2/3 boundary](design-docs/CHUNK-2-3-BOUNDARY.md) · [test harness plan](design-docs/TEST-HARNESS-PLAN.md)
- [Chunk 3: Judge, agent, and evaluation](design-docs/CHUNK-3-JUDGE-AGENT-EVAL.md)
- [Chunk 4: Dashboard and demo](design-docs/CHUNK-4-DASHBOARD-DEMO.md)

## Development

Needs Node 22.13 or later (`.nvmrc`) and pnpm. Corepack ships with Node and installs the pnpm version pinned in `package.json`:

```bash
corepack enable
pnpm install
cp .env.example .env
```

| Command | What it does |
|---|---|
| `pnpm test` | All workspace tests (Vitest), including `eval/` |
| `pnpm test:coverage` | Tests with a coverage report |
| `pnpm run typecheck` | TypeScript project build (`tsc -b`), then `eval/` and colocated tests |
| `pnpm run lint` | ESLint, including the project's safety rules |
| `pnpm run format:check` | Prettier check (`pnpm run format` to fix) |
| `pnpm run build` | Compile every package to `dist/` |
| `pnpm --filter @apf/gateway dev` | Gateway on `http://localhost:4000` with reload |

| Path | Owner |
|---|---|
| `packages/contracts` | Shared types, zod schemas, reason codes (Chunk 2) |
| `apps/gateway` | Hono API and pipeline (Chunk 2; `src/payments` Chunk 1, `src/judge` and `src/catalog` Chunk 3) |
| `eval/` | Judge evaluation cases and runner (Chunk 3) |
| `tests/` | Python reference suite; see `tests/README.md` |

Never commit `.env`. Keys are testnet only.
