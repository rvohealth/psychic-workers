# AGENTS.md - AI Agent Instructions

## Public Error Exports

Export an error only when a developer of a Psychic application needs to throw
it or should reasonably be able to catch it as part of an expected,
well-functioning application workflow. An error being useful for debugging,
logging, or framework internals does not by itself justify a public export.
Compatibility-only residue (an error kept exported only for backward
compatibility, not because new code should throw or catch it) must be
documented as such, not treated as proof it still belongs in the public API.

## Updating Dependencies

When a transitive package is stale or vulnerable, inspect its dependency paths
(`pnpm why` and the lockfile), then **first update the direct/top-level
packages that bring it in** to the latest supportable releases. Update their
declarations in `package.json`, regenerate `pnpm-lock.yaml`, and inspect every
resolved copy of the transitive package. Do not add a transitive package as an
unrelated direct dependency and assume that fixes its other copies. (Psychic
PR #544 updated direct Ajv, fast-json-stringify, and Supertest rather than
adding overrides.)

If the owning direct packages are already current or cannot resolve the issue,
next try a compatible lockfile refresh and trace remaining paths to other
upgradable parents.

**Do not add or retain `overrides`/`resolutions` while any parent-package or
normal resolution route works. If those routes are impossible, ask the user
before even considering an override; do not introduce one autonomously.** A
release-age obstacle is handled as an explicit, exact-version, user-approved
exception, not a dependency override.

- Check advisories (`pnpm audit`) and the actual resolved graph after each
  attempt.
- Respect the repo's `.npmrc` release-age and registry policy, and keep
  install/security controls (`allowBuilds`, etc.) intact.
- Keep the pinned `packageManager` version and integrity hash reproducible.
  Evaluate a pnpm/toolchain bump deliberately, especially across majors, rather
  than using one to mask a dependency or local-store problem.
- Align `@rvoh/dream`, `@rvoh/psychic`, the spec helpers, Koa, BullMQ, Redis,
  and TypeScript as one compatible set. Do not take a latest major that breaks
  the supported runtime or peer contract, and do not narrow or widen peer
  ranges without evidence.
- Before claiming the update works, run a frozen-lockfile install
  (`pnpm install --frozen-lockfile`), `pnpm build`, `pnpm lint`, the specs,
  `pnpm psy sync` (a new Psychic can regenerate `openapi.json`; CI fails on
  any sync diff), and any relevant integration checks against the resolved graph. A green run
  against the old lockfile proves nothing.
- Record intentionally held versions and compatibility limits in
  CHANGELOG/TSDoc.
- Node policy: Node 26 is the primary development, CI, and release runtime;
  Node 24 is the oldest supported one (`engines.node: ">=24"`). `@types/node`
  tracks 26, but typings do not prove runtime support, so run the install,
  build, lint, and specs on both Node 24 and Node 26 before claiming either.
