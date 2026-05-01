# Releasing

Manual publish from a developer machine. CI just sanity-checks PRs/main
(typecheck + build + unit tests). Releases are not driven by GH Actions —
publishing on tag was tried and dropped because it wasn't worth the
operational overhead at this stage.

## Cutting a release

```bash
# 1. Make sure main is green and the working tree is clean.
git checkout main && git pull
bun run typecheck && bun run build
cd packages/core && bun test && cd ../..

# 2. Bump the version in all four package.json files (single coordinated version).
NEW_VERSION="0.1.1"
for pkg in packages/core packages/core-exporters packages/extra-exporters packages/create; do
  node -e "
    const fs = require('fs');
    const path = '${pkg}/package.json';
    const j = JSON.parse(fs.readFileSync(path, 'utf8'));
    j.version = '${NEW_VERSION}';
    fs.writeFileSync(path, JSON.stringify(j, null, '\t') + '\n');
  "
done

# 3. Commit + tag + push.
git add packages/*/package.json
git commit -m "chore(release): v${NEW_VERSION}"
git tag "v${NEW_VERSION}" && git push origin main "v${NEW_VERSION}"

# 4. Publish in order. bun rewrites workspace:* to the real semver in the tarball.
cd packages/core            && bun publish --access public && cd ../..
cd packages/core-exporters  && bun publish --access public && cd ../..
cd packages/extra-exporters && bun publish --access public && cd ../..
cd packages/create          && bun publish --access public && cd ../..

# 5. Verify on npm.
for p in schema-pop @schema-pop/core-exporters @schema-pop/extra-exporters create-schema-pop; do
  printf "%-35s " "$p"
  npm view "$p" version
done
```

## v0.1.0 — kick-off

The very first `0.1.0` of all four packages was published on 2026-05-01.
Local tag `v0.1.0` exists on `main`.

## Versioning policy (0.1)

Single coordinated version across all four packages. They are tightly
coupled — the exporter packages match the core IR shape, and the
`create-schema-pop` scaffold pins to specific versions.

Independent versioning will come later (probably via [changesets](https://github.com/changesets/changesets))
once the community starts publishing third-party exporters. Until 0.2
ships and freezes the `ExporterPlugin` interface, breaking changes can
land in any minor.

## Pre-release / beta

```bash
NEW_VERSION="0.2.0-beta.1"
# (same bump steps as above, then:)
cd packages/core && bun publish --access public --tag beta && cd ../..
# ... etc, repeat for the other three packages with --tag beta
```

Users opt-in via `bun add schema-pop@beta`.

## When something goes wrong

- **Publish fails halfway** (e.g. core succeeded, extras failed): re-run
  `bun publish` for the failed packages — already-published versions
  return an error which is harmless. If you need to fix the content,
  bump the patch and republish; npm doesn't allow overwriting versions.
- **Wrong content published**: `npm unpublish` is allowed within 72h and
  only if no dependents exist. Easier path is publishing a new patch.
- **npm token issues**: `npm whoami` to sanity-check; `npm config set
  //registry.npmjs.org/:_authToken <token>` to refresh.
