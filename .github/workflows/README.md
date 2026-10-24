# CI/CD setup

`ci.yml` runs on pull requests, pushes to `main`, and manual dispatch.
It uses read-only repository permissions and cancels superseded runs on the same ref.

The repository currently contains only `README.md` and `Design.md`. There is no
implemented language toolchain, package manager, application, or existing check
command. The inspection job reports this in the Actions summary; application
checks are explicitly skipped until a root `package.json` exists.

## Activating application checks

The design proposes TypeScript/Node and Next.js. This scaffold assumes Node 22
and npm; these are CI defaults, not existing repository requirements. When adding
the application:

1. Commit a root `package.json` and `package-lock.json`. If using another package
   manager or a different runtime version, update the workflow accordingly.
2. Define real, non-interactive scripts: `lint`, `format:check`, `typecheck`,
   `test`, and `build`. Formatting must check without writing; tests must run once
   without watch mode. For a workspace, root scripts must cover all packages.
3. The workflow validates these prerequisites, sets up Node with the npm download
   cache keyed by the lockfile, installs with `npm ci`, and runs each check in order.
   Missing scripts fail CI rather than silently skipping checks.

No application scripts or dependencies have been invented for this docs-only
repository. Once tests exist, include the design's canary, parallel-reservation,
and settlement/crash reliability cases in `npm test`. Keep CI deterministic with
mocked external services and no wallet or model credentials. If the implementation
does not use TypeScript, replace the type-check step with the applicable check.

## CD PLACEHOLDER

`Design.md` specifies local hosting for the demo; Azure is conditional. No deploy
target, deployment command, artifact, or credentials are configured, so there is
no deploy job. Once those are chosen, add a job gated on successful application
checks and pushes to `main`, with an appropriate GitHub environment and scoped
deployment credentials.
