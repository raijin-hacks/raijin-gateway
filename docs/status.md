# chunk 3 status

## Phases

| Phase | What it delivers | Where |
|---|---|---|
| 1 | Catalog and judge interfaces, shared contract schemas, strict output validator, explicit stub judges, paper fixtures | `main` |
| 2 | Real judge adapter: fixed prompt, 5 s abortable deadline, 64 KiB response cap, no retries, paper-eval CLI | `main` (#11) |
| 3 | Trusted catalog (`catalog/catalog.json`) and loader that rejects ambiguous or invalid catalogs at startup | `main` (#13) |
| 4 | URL canonicalizer and endpoint matcher. HTTP is allowed only for exact catalog origins on loopback. Unknown routes escalate before any quote or judge call. | `main` (#15) |
| 5 | Allowlist judge-input builder; canary tests prove no attacker text reaches the model | `main` (#16) |
| 6 | `/pay` pipeline: idempotency, atomic reservations, grants, judge routing, quarantine, human review, recovery | PR `chunk3/phase6` |
| — | Approval-time rechecks of trust and the new-payee limit (race-condition fixes) | PR `fix/approve-time-rechecks` |
| — | Payments hardening: 300 s authorization cap, on-chain settlement proof, 1 MiB response cap | PR `fix/payments-hardening` |
| — | J2b DNS/IP destination classifier, not wired in yet | draft PR `feat/j2b-destination-classifier` |
| 7 | API evaluation: frozen 20 + 20 cases, 17 held-out variants, deterministic baseline, worst-run scoring, report | `chunk3/phase7` |
| 8 | Demo agent (`apps/agent`): two tools, restricted page fetch, idempotent paid client, redacted trace, mock rehearsal | `chunk3/phase8` |

Real payments are disabled on purpose: `apps/gateway/src/main.ts` blocks real quotes and payments until J2b is complete. Everything below runs in mock payments mode.

## Branch stack and merge order

Nothing from phase 6 onward is on `main` yet. The branches are stacked:

```
main
└── chunk3/phase6
    ├── fix/approve-time-rechecks
    │   └── fix/payments-hardening
    │       └── chunk3/phase7
    │           └── chunk3/phase8
    └── feat/j2b-destination-classifier   (draft)
```

Merge in this order: **phase 6 → approve-time rechecks → payments hardening → phase 7 → phase 8.** The J2b classifier merges whenever J2b is finished.

The team squash-merges. A squash merge gives `main` new commit IDs, so every branch stacked on the merged one shows conflicts until it is rebased. After each squash merge, rebase the next branch onto `main`, replaying only its own commits:

```sh
git switch <next-branch>
git rebase --onto origin/main <last-commit-of-the-branch-just-merged>
git push --force-with-lease
```

## Verification at the top of the stack

On `chunk3/phase8`, outside the Codex sandbox: 1,416 tests passed, 3 todo, 0 failures. Lint, format check, typecheck, build, `pnpm agent:rehearse` and a frozen-lockfile install all pass.
