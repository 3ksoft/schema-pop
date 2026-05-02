#!/usr/bin/env bash
# Rebuild tree-sitter language grammars (rust / c / cpp) to wasm from
# upstream sources — refresh with `./scripts/build-wasm.sh` whenever you
# want a newer revision in `wasm/`.
#
# Toolchain:
#   * tree-sitter CLI — invoked via `bunx tree-sitter-cli`, no global
#     install required. On first run bun caches it in ~/.bun.
#   * Compiler: either `emcc` on PATH OR `docker` running. The
#     tree-sitter CLI prefers emcc for speed, falls back to docker.
#
# Pinning: by default builds the default branch HEAD of each grammar
# repo. Override per-grammar with env vars:
#   RUST_REV=v0.21.0 ./scripts/build-wasm.sh
#   C_REV=v0.21.0 CPP_REV=v0.22.0 ./scripts/build-wasm.sh
#
# Note: the runtime `tree-sitter.wasm` (Emscripten core) lives inside
# the `web-tree-sitter` npm package — bump that via `bun add` if you
# need a newer ABI; we do NOT rebuild it here.

set -euo pipefail
cd "$(dirname "$0")/.."

WASM_DIR="$(pwd)/wasm"
BUILD_DIR="$(pwd)/.build/grammars"

# Prefer system `tree-sitter` if available (fast, no bunx download
# overhead). Fall back to bunx so the script works on a fresh checkout.
if command -v tree-sitter >/dev/null 2>&1; then
	TS=(tree-sitter)
elif command -v bunx >/dev/null 2>&1; then
	TS=(bunx --bun tree-sitter-cli)
else
	echo "error: need either \`tree-sitter\` or \`bunx\` on PATH" >&2
	exit 1
fi

# Each grammar entry: <lang>|<repo-url>|<env-var-for-rev>
GRAMMARS=(
	"rust|https://github.com/tree-sitter/tree-sitter-rust|RUST_REV"
	"c|https://github.com/tree-sitter/tree-sitter-c|C_REV"
	"cpp|https://github.com/tree-sitter/tree-sitter-cpp|CPP_REV"
)

check_prereqs() {
	if ! command -v emcc >/dev/null 2>&1 && ! docker info >/dev/null 2>&1; then
		echo "error: need either emcc or a running docker daemon" >&2
		echo "  install emcc:    https://emscripten.org/docs/getting_started" >&2
		echo "  start docker:    systemctl start docker" >&2
		exit 1
	fi
	echo "→ tree-sitter CLI: ${TS[*]}"
	"${TS[@]}" --version | head -1 | sed 's/^/  /'
	if command -v emcc >/dev/null 2>&1; then
		echo "  emcc $(emcc --version 2>/dev/null | head -1 | awk '{print $NF}')"
	else
		echo "  docker (emcc fallback)"
	fi
}

build_grammar() {
	local lang="$1" url="$2" rev_var="$3"
	local rev="${!rev_var:-}"
	local dir="$BUILD_DIR/tree-sitter-$lang"

	if [[ -d "$dir/.git" ]]; then
		echo "→ updating tree-sitter-$lang"
		git -C "$dir" fetch --tags --quiet origin
	else
		echo "→ cloning tree-sitter-$lang"
		git clone --quiet "$url" "$dir"
	fi

	if [[ -n "$rev" ]]; then
		echo "  pinning to $rev"
		git -C "$dir" checkout --quiet "$rev"
	else
		# Default branch HEAD — figure out which one (main vs master).
		local default_branch
		default_branch=$(git -C "$dir" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's|^origin/||' || echo master)
		git -C "$dir" checkout --quiet "$default_branch"
		git -C "$dir" reset --hard --quiet "origin/$default_branch"
	fi

	local resolved
	resolved=$(git -C "$dir" describe --tags --always)

	echo "  building @ $resolved"
	# `tree-sitter generate` first to make sure parser.c is up to date,
	# then build wasm. Some grammar repos ship with a stale parser.c so
	# regenerating is the safe default.
	(
		cd "$dir"
		"${TS[@]}" generate --quiet 2>/dev/null || true
		"${TS[@]}" build --wasm -o "$WASM_DIR/tree-sitter-$lang.wasm"
	)

	local size
	size=$(du -h "$WASM_DIR/tree-sitter-$lang.wasm" | cut -f1)
	echo "  ✓ tree-sitter-$lang.wasm @ $resolved ($size)"
}

# Record what got built so the next checkout knows the provenance.
write_manifest() {
	local manifest="$WASM_DIR/MANIFEST.json"
	local entries=()
	for entry in "${GRAMMARS[@]}"; do
		IFS='|' read -r lang _ _ <<<"$entry"
		local dir="$BUILD_DIR/tree-sitter-$lang"
		[[ -d "$dir/.git" ]] || continue
		local rev
		rev=$(git -C "$dir" rev-parse HEAD)
		local desc
		desc=$(git -C "$dir" describe --tags --always)
		entries+=("  \"$lang\": { \"rev\": \"$rev\", \"describe\": \"$desc\" }")
	done
	{
		echo "{"
		echo "  \"_built_at\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\","
		# join entries with commas
		local joined
		joined=$(IFS=$',\n' ; echo "${entries[*]}")
		echo "$joined"
		echo "}"
	} >"$manifest"
	echo
	echo "→ manifest: $manifest"
}

check_prereqs
mkdir -p "$WASM_DIR" "$BUILD_DIR"

for entry in "${GRAMMARS[@]}"; do
	IFS='|' read -r lang url rev_var <<<"$entry"
	build_grammar "$lang" "$url" "$rev_var"
done

write_manifest

echo
echo "✓ done — output in $WASM_DIR"
echo
echo "Verify with:  bun test"
