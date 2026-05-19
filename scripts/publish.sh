#!/usr/bin/env bash
# Publish all schema-pop packages to npm under a single coordinated version.
#
#   scripts/publish.sh 0.2.0
#   scripts/publish.sh 0.2.0 --dry-run
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

# Publish order matters: dependencies first.
PACKAGES=(
	packages/schema
	packages/core
	packages/exporter
	packages/importer
	packages/cli
	packages/create
)

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

echo "==> Build (schema, core, exporter, importer, cli)"
bun run build

echo "==> Unit tests"
bun run test

echo "==> Syncing root README into library packages"
for pkg in packages/schema packages/core packages/exporter packages/importer; do
	cp README.md "$pkg/README.md"
done

echo "==> Publishing"
for pkg in "${PACKAGES[@]}"; do
	echo "    -> $pkg"
	(cd "$pkg" && bun publish --access public $DRY_RUN)
done

if [ -z "$DRY_RUN" ]; then
	echo "==> Verifying versions on npm"
	for p in @schema-pop/schema @schema-pop/core @schema-pop/exporter @schema-pop/importer schema-pop create-schema-pop; do
		printf "    %-30s " "$p"
		npm view "$p" version 2>/dev/null || echo "(not found)"
	done
fi

echo "==> Done."
