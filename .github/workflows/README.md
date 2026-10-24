# CI/CD setup

`ci.yml` runs on pull requests, pushes to `main`, and manual dispatch.
It uses read-only repository permissions and cancels superseded runs on the same ref.

The unconditional `Python tests` job sets up Python 3.12, caches pip downloads,
installs `requirements-test.txt`, and runs `python -m pytest`. Local venv setup
is documented in `tests/README.md`.

## Node application checks

The repository is a pnpm workspace (`final_contracts.md` section 0). The
inspection job checks that the root `package.json` names an exact pnpm version
in `packageManager`, that `pnpm-lock.yaml` is committed, and that these scripts
exist: `lint`, `format:check`, `typecheck`, `test`, and `build`. Missing scripts
fail CI rather than silently skipping checks.

The `checks` job then installs that pnpm version with `pnpm/action-setup` (it
reads `packageManager`), sets up the Node version in `.nvmrc` with the pnpm store
cache keyed by the lockfile, installs with `pnpm install --frozen-lockfile`, and
runs each check in order. The root scripts cover every workspace package.

Keep CI deterministic: mocked external services, no wallet or model credentials.
Include the design's canary, parallel-reservation, and settlement/crash
reliability cases in `pnpm test` as they are written (see `TEST-HARNESS-PLAN.md`).
The Python tests run independently of the Node checks.

## CD PLACEHOLDER

`Design.md` specifies local hosting for the demo; Azure is conditional. No deploy
target, deployment command, artifact, or credentials are configured, so there is
no deploy job. Once those are chosen, add a job gated on successful application
checks and pushes to `main`, with an appropriate GitHub environment and scoped
deployment credentials.
