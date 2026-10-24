# CI/CD setup

`ci.yml` runs on pull requests, pushes to `main`, and manual dispatch.
It uses read-only repository permissions and cancels superseded runs on the same ref.

Python tests run independently using Python 3.12 and `requirements-test.txt`.
Local setup is documented in `tests/README.md`.

## pnpm workspace checks

The workspace uses Node 22 and the exact pnpm version pinned in the root
`package.json` (`packageManager`). CI installs pnpm using `pnpm/action-setup`,
caches its store using `pnpm-lock.yaml`, and runs
`pnpm install --frozen-lockfile`. Commit lockfile changes alongside dependencies.
Do not generate or commit an npm `package-lock.json` for this workspace.

CI runs each root script when available: `lint`, `format:check`, `typecheck`,
`test`, and `build`. All five exist today. A missing script is reported as
pending in the Actions summary and skipped; dependency installation and Python
tests still run.
As tooling is implemented, add real, non-interactive root scripts covering all
workspace packages. Formatting should check without writing; tests should run
once without watch mode, using mocked external services and no wallet or model
credentials. CI automatically enables each check when its root script is added.

## Deployment

[The design](../../design-docs/Design.md) specifies local hosting for the demo; Azure is
conditional. Deployment remains pending a host, build artifact, environment,
and credentials. Gate future deployment on successful checks and a push to main.
