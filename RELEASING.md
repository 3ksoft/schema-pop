# Releasing

Tag-driven release. Pushing a `v*.*.*` tag publishes all four packages to npm in the right order with provenance.

## One-time setup

Only needed before the very first publish.

### 1. npm organization + reserved names

Register on [npmjs.com](https://www.npmjs.com):

- **org `schema-pop`** (free for public packages) — covers `@schema-pop/core-exporters` and `@schema-pop/extra-exporters`
- **unscoped `schema-pop`** — published from `packages/core/`
- **unscoped `create-schema-pop`** — published from `packages/create/`

The `schema-pop` and `create-schema-pop` names are reserved by the first successful publish; no manual reservation step.

### 2. npm access token

On npmjs.com → settings → access tokens → **Generate New Token** → **Granular Access Token**:

- **Permissions**: read & write on org `schema-pop`, plus read & write on packages `schema-pop` and `create-schema-pop`
- **Lifetime**: at least until next planned release; the workflow re-runs every release so a 1-year token is fine
- **Type**: automation (skips 2FA prompts)

### 3. GitHub secret

Repository → settings → secrets and variables → actions → **New repository secret**:

- Name: `NPM_TOKEN`
- Value: the token from step 2

That's it. CI/release workflows already exist in `.github/workflows/`.

## v0.1.0 — kick-off was published locally

The very first `0.1.0` of all four packages was published from a developer
machine on 2026-05-01, *before* `NPM_TOKEN` was wired up to GH Actions. The
local tag `v0.1.0` exists on `main` but is intentionally **not pushed** — the
release workflow would fail on a duplicate publish if the tag fired.

From `0.1.1` onwards the workflow drives every release.

## Cutting a release

```bash
# 1. Make sure main is green and ready.
git checkout main
git pull
bun run typecheck && bun run build && cd packages/core && bun test && cd ../..

# 2. Pick a version. Single coordinated version for all 4 packages.
NEW_VERSION="0.1.1"

# 3. Tag and push. The release workflow handles the rest.
git tag "v${NEW_VERSION}"
git push origin "v${NEW_VERSION}"
```

The `release.yml` workflow:

1. Bumps all 4 `package.json` files to `${NEW_VERSION}` (and pins internal cross-deps to that exact version).
2. Runs typecheck + build + core unit tests.
3. Publishes in order: `schema-pop` → `@schema-pop/core-exporters` → `@schema-pop/extra-exporters` → `create-schema-pop`. All four with `--access public` and npm provenance attestation.
4. Commits the version bumps back to `main` as `chore(release): v${NEW_VERSION}`.
5. Creates a GitHub Release with auto-generated notes from PR/commit history.

## Versioning policy (0.1)

Single coordinated version across all 4 packages. They are tightly coupled — `@schema-pop/core-exporters` matches the `schema-pop` IR shape, `create-schema-pop` ships templates that pin to specific versions.

Independent versioning will come later (probably via [changesets](https://github.com/changesets/changesets)) once the community starts publishing third-party exporters and individual packages need to evolve at different paces.

Until 0.2 ships and freezes the `ExporterPlugin` interface, breaking changes can land in any minor.

## Pre-release / beta

```bash
git tag "v0.2.0-beta.1"
git push origin "v0.2.0-beta.1"
```

`bun publish` honors the `-beta.N` semver convention and tags the npm dist as `beta` automatically. Users opt-in via `bun add schema-pop@beta`.

## When something goes wrong

- **Publish fails halfway** (e.g. core published, extras failed): re-run the workflow from GitHub UI. `bun publish` is idempotent for the same version — already-published packages return an error which the workflow swallows; failed ones retry. Worst case: bump the patch and tag again.
- **Wrong version published**: npm allows `npm unpublish` only within 72h and only if no dependents exist. Easier path is publishing a new patch with the correct content.
- **Token expired**: regenerate, update `NPM_TOKEN` secret, re-tag with a patch bump.

## Workflows reference

- `.github/workflows/ci.yml` — runs on every push and PR. Fast (typecheck + core tests). Full E2E (Verdaccio + Docker) gated to main pushes or PRs labelled `e2e`.
- `.github/workflows/release.yml` — triggered by `v*.*.*` tags. Publishes + bumps + GH release.
