# Contributing to psychic-workers

`@rvoh/psychic-workers` is the BullMQ-backed background job and scheduling
plugin for [Psychic](https://psychic-docs.netlify.app/docs/plugins/workers/overview).
The library lives in `src/`. `test-app/` is a small Psychic/Dream application
that the specs in `spec/unit/` run against. There are only unit specs (no
feature or browser specs), and there is a single `package.json` to install.

## Prerequisites

- **Node.js 26** (primary: release workflow and most CI jobs) or **Node 24**
  (oldest supported, `engines.node: ">=24"`; CI runs the unit specs and build on
  both).
- **pnpm 12.14.0**, pinned through `packageManager` in `package.json`. Use one
  of:
  - **corepack.** Node 24 bundles it, but you need **Node 24.12.0 or later**:
    older Node 24 releases bundle corepack 0.34.4 or earlier, which cannot
    launch pnpm 12 (every `pnpm` command fails with `MODULE_NOT_FOUND` for
    `.../pnpm/12.14.0/bin/pnpm.cjs`). On an older Node 24, run
    `npm i -g corepack@0.34.7` first. Node 26 does not bundle corepack, so
    install it there with `npm i -g corepack`. Then run `corepack enable`.
  - **A standalone pnpm** (`npm i -g pnpm`). pnpm reads `packageManager` and
    switches itself to 12.14.0 inside this repo.

  Check with `pnpm -v` in the repo root: it should print `12.14.0`.

- **PostgreSQL**, for the test-app database. CI uses `postgres:13`. Any
  reasonably current server works locally.
- **Redis** on `localhost:6379` with no auth, for BullMQ. CI uses `redis:6.2`.
  `test-app/src/conf/workers.ts` reads `REDIS_HOST`, `REDIS_PORT` (default
  6379), `REDIS_USER` and `REDIS_PASSWORD` if your Redis is elsewhere.

## Setup

```sh
pnpm install --frozen-lockfile
```

Dependency install scripts are denied by policy (see
[Supply-chain policy](#dependency-updates-and-supply-chain-policy)), so no
build step runs during install.

Create `.env.test` in the repo root. It is gitignored (`.env*`), and the specs
and `pnpm psy` load it when `NODE_ENV=test`, which `pnpm psy` defaults to:

```sh
PORT=7777
DB_USER=<your postgres user>
DB_NAME=psychic_workers_test
DB_HOST=localhost
DB_PORT=5432
TZ=UTC
```

Add `DB_PASSWORD=...` if your Postgres user needs one, and `DB_USE_SSL=1` to
connect over SSL. Then create and migrate the test database:

```sh
pnpm psy db:create
pnpm psy db:migrate
```

`pnpm psy db:migrate` also runs `psy sync`, which regenerates the test-app's
generated files (types and `openapi.json`). CI runs
`pnpm psy db:migrate --skip-sync` and then a separate sync check (below).
`pnpm psy db:drop` and `pnpm psy db:reset` are available when you need a clean
database.

No build is needed before running the specs: they run the TypeScript sources
through Vitest.

## Running checks

| Command               | What it does                                                                                                                                               |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm uspec`          | Unit specs (Vitest, `spec/unit/`). Needs Postgres and Redis. Pass a path to run a subset, e.g. `pnpm uspec spec/unit/background`.                          |
| `pnpm lint`           | ESLint on `src/`, `spec/` and `test-app/`, then `prettier --check .` (`.prettierignore` skips generated files, `dist/` and `.github/`).                    |
| `pnpm format`         | `prettier --write` on the whole repo.                                                                                                                      |
| `pnpm build`          | Type-checks and compiles `src/` to `dist/cjs`, `dist/esm` and `dist/types`.                                                                                |
| `pnpm build:test-app` | Compiles `src/`, `test-app/` and `spec/` (a type-check of all three). It replaces `dist/`, so rerun `pnpm build` afterwards if you need the package build. |
| `pnpm psy sync`       | Regenerates the test-app's synced files. Commit whatever it changes.                                                                                       |

The **PR Checks** workflow (`.github/workflows/pr-checks.yml`) runs on every
pull request:

- **Unit tests** on Node 26 and 24: `pnpm install --frozen-lockfile`,
  `pnpm psy db:migrate --skip-sync`, `pnpm uspec`.
- **Linting** on Node 26: `pnpm lint`.
- **Check build** on Node 26 and 24: `pnpm build`, then it imports and
  requires every entry point (`@rvoh/psychic-workers`, `/errors`, `/types`,
  `/utils`) as both ESM and CJS, then `pnpm build:test-app`.
- **Ensure no sync diffs** on Node 26: `pnpm psy db:migrate --skip-sync`,
  `pnpm psy sync`, and it fails if that leaves any `git diff`.

Before opening a PR, run at least:

```sh
pnpm lint && pnpm build && pnpm build:test-app && pnpm uspec && pnpm psy sync && git status
```

If you change dependencies or anything runtime-sensitive, run the same on both
Node 24 and Node 26.

## Dependency updates and supply-chain policy

Follow the procedure in [AGENTS.md](./AGENTS.md#updating-dependencies). It
applies to humans as well as agents. In short:

- Fix a stale or vulnerable transitive package by updating the direct packages
  that bring it in. Regenerate `pnpm-lock.yaml` with `package.json`, then check
  `pnpm why <pkg>` and `pnpm audit` against the new graph.
- **Never add or keep `overrides`/`resolutions` without maintainer approval.**
  Use them only when no parent-package or normal resolution route works.
- Keep `@rvoh/dream`, `@rvoh/psychic`, their spec helpers, Koa, BullMQ, Redis
  and TypeScript aligned as one compatible set. Do not change the public peer
  ranges without evidence.
- Keep the pinned `packageManager` version and hash. Bump pnpm deliberately,
  not to work around a dependency problem.
- Record intentionally held-back versions and compatibility limits in
  `CHANGELOG.md`.

Supply-chain settings (see also [SECURITY.md](./SECURITY.md)):

- The release-age cooldown lives in **`pnpm-workspace.yaml`**:
  `minimumReleaseAge: 4320` (3 days), with `@rvoh/*` (our own packages) as the
  only `minimumReleaseAgeExclude` entry. pnpm enforces it on every install,
  including CI's `pnpm install --frozen-lockfile`; there is no separate CI
  check (see
  [AGENTS.md](./AGENTS.md#ci-tooling-industry-standards-only)). Changes to
  `pnpm-workspace.yaml` and `.npmrc` are reviewed like any other code change.
  A version that is still inside the cooldown can be taken only as an
  explicit, exact-version exception that a maintainer approves, never as an
  override.
- **`.npmrc` holds registry settings only.** pnpm 11+ ignores release-age keys
  there.
- `allowBuilds` in `pnpm-workspace.yaml` is a supply-chain allowlist for
  dependency install scripts. Every current entry is `false`. Keep it minimal.

## Changes and pull requests

- Branch from `main` and open the PR against `main`. `CODEOWNERS` requests
  review from the maintainers.
- Keep `pnpm psy sync` output committed. CI fails on a sync diff.
- `CHANGELOG.md` has one `## x.y.z` section per release. Bullets usually
  start with the kind of change (`fix:`, `maintenance:`, `docs:`, `add ...`)
  and spell out any behavior a consumer must adapt to.
- **Breaking changes**: a change that makes any existing caller stop compiling
  or behave differently, including removing a default or making an option
  required, is breaking. It needs the maintainers' approval and a major
  version. See [AGENTS.md](./AGENTS.md#breaking-changes) for what counts and
  how to check.
- **Public error exports** (`@rvoh/psychic-workers/errors`): export an error
  only when a Psychic application developer needs to throw it, or should
  reasonably catch it, as part of a normal application workflow. Being useful
  for debugging, logging or framework internals is not enough. An error kept
  exported only for backward compatibility must be documented as such. See
  [AGENTS.md](./AGENTS.md#public-error-exports).
- `src/` must keep running on Node 24, so do not use runtime APIs added in
  Node 25 or 26.

## Releases

Releases are published from GitHub Actions with npm trusted publishing (OIDC)
and provenance, when a GitHub release is published. A release PR bumps
`version` in `package.json` and adds the `CHANGELOG.md` entry. The tag
`vX.Y.Z` must match that version. See [RELEASING.md](./RELEASING.md).

## Security

Report vulnerabilities privately as described in [SECURITY.md](./SECURITY.md),
not in a public issue.
