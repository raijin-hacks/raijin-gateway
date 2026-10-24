# calhacks-13.0

Agent Payment Firewall: a payment gateway that checks _why_ an AI agent is paying, against the task a human gave it, before anything is signed. Start with `Design.md`; `final_contracts.md` is the source of truth for interfaces.

## Development

Needs Node 22.13 or later (`.nvmrc`) and pnpm. Corepack ships with Node and installs the pnpm version pinned in `package.json`:

```bash
corepack enable
pnpm install
cp .env.example .env
```

| Command | What it does |
|---|---|
| `pnpm test` | All workspace tests (Vitest) |
| `pnpm run typecheck` | TypeScript project build (`tsc -b`) |
| `pnpm run lint` | ESLint, including the project's safety rules |
| `pnpm run format:check` | Prettier check (`pnpm run format` to fix) |
| `pnpm run build` | Compile every package to `dist/` |
| `pnpm --filter @apf/gateway dev` | Gateway on `http://localhost:4000` with reload |

| Path | Owner |
|---|---|
| `packages/contracts` | Shared types, zod schemas, reason codes (Chunk 2) |
| `apps/gateway` | Hono API and pipeline (Chunk 2; `src/payments` Chunk 1, `src/judge` and `src/catalog` Chunk 3) |
| `tests/` | Python reference suite; see `tests/README.md` |

Never commit `.env`. Keys are testnet only.
