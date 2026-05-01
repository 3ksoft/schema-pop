#!/usr/bin/env bash
# Publish all four packages to npm under a single coordinated version.
#
#   scripts/publish.sh 0.1.5
#   scripts/publish.sh 0.1.5 --dry-run
#
# Does NOT touch git (no commit, no tag, no push). Run a normal release
# commit after this if/when you want one.

set -euo pipefail

if [ -z "${1-}" ]; then
	echo "Usage: scripts/publish.sh <version> [--dry-run]" >&2
	exit 1
fi

VERSION="$1"
DRY_RUN=""
if [ "${2-}" = "--dry-run" ]; then
	DRY_RUN="--dry-run"
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PACKAGES=(packages/core packages/core-exporters packages/extra-exporters packages/create)

if [ -z "$DRY_RUN" ]; then
	echo "==> Bumping all packages to $VERSION (and pinning workspace deps)"
	for pkg in "${PACKAGES[@]}"; do
		node -e "
			const fs = require('fs');
			const p = '$pkg/package.json';
			const j = JSON.parse(fs.readFileSync(p, 'utf8'));
			j.version = '$VERSION';
			// bun publish rewrites workspace:* to the LAST PUBLISHED version
			// (not the local bumped version), which leaves siblings out of
			// sync. Pin them ourselves so the published tarball deps match.
			for (const section of ['dependencies', 'peerDependencies']) {
				if (!j[section]) continue;
				for (const dep of Object.keys(j[section])) {
					if (dep === 'schema-pop' || dep.startsWith('@schema-pop/')) {
						j[section][dep] = '$VERSION';
					}
				}
			}
			fs.writeFileSync(p, JSON.stringify(j, null, '\t') + '\n');
		"
	done
else
	echo "==> Skipping version bump (dry-run; package.json keeps current version)"
fi

echo "==> Typecheck"
bun run typecheck

echo "==> Build"
bun run build

echo "==> Unit tests"
(cd packages/core && bun test)

echo "==> Syncing README into core / core-exporters / extra-exporters"
for pkg in packages/core packages/core-exporters packages/extra-exporters; do
	cp README.md "$pkg/README.md"
done

echo "==> Publishing"
for pkg in "${PACKAGES[@]}"; do
	echo "    -> $pkg"
	(cd "$pkg" && bun publish --access public $DRY_RUN)
done

if [ -z "$DRY_RUN" ]; then
	echo "==> Verifying versions on npm"
	for p in schema-pop @schema-pop/core-exporters @schema-pop/extra-exporters create-schema-pop; do
		printf "    %-35s " "$p"
		npm view "$p" version 2>/dev/null
	done
fi

echo "==> Done."
