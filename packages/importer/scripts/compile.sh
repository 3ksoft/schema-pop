#!/usr/bin/env bash
# Compile a single-file native binary of the unified schema-pop importer.
# Bun handles bundling, including the tree-sitter `.wasm` grammars
# (imported as file assets), so the result is zero-dep for the Rust
# path. Clang is still required at runtime for C / C++ — the binary
# spawns it as a child process and passes its full path through
# `--clang <path>`.
#
# Usage:
#   ./scripts/compile.sh                          # current platform
#   TARGET=bun-darwin-arm64 ./scripts/compile.sh  # cross-compile
#
# Output: dist/schema-pop-import (or .exe on Windows targets).

set -euo pipefail
cd "$(dirname "$0")/.."

# Auto-detect target if not provided.
if [[ -z "${TARGET:-}" ]]; then
	case "$(uname -s)-$(uname -m)" in
		Linux-x86_64)   TARGET="bun-linux-x64" ;;
		Linux-aarch64)  TARGET="bun-linux-arm64" ;;
		Darwin-x86_64)  TARGET="bun-darwin-x64" ;;
		Darwin-arm64)   TARGET="bun-darwin-arm64" ;;
		MINGW*|MSYS*|CYGWIN*) TARGET="bun-windows-x64" ;;
		*) echo "error: unknown platform $(uname -s)-$(uname -m); set TARGET= manually." >&2; exit 1 ;;
	esac
fi

OUT_DIR="dist"
OUT_FILE="$OUT_DIR/schema-pop-import"
[[ "$TARGET" == *windows* ]] && OUT_FILE="${OUT_FILE}.exe"

mkdir -p "$OUT_DIR"
echo "→ compiling for $TARGET"
bun build --compile --target="$TARGET" ./src/cli.ts --outfile "$OUT_FILE"

# Bun stamps the file mode for us; this is just belt-and-suspenders for
# git checkouts that lost +x somewhere along the way.
chmod +x "$OUT_FILE" 2>/dev/null || true

echo
echo "✓ built: $OUT_FILE"
echo "  target: $TARGET"
echo "  size:   $(du -h "$OUT_FILE" | cut -f1)"
echo
echo "Quick test:"
echo "  $OUT_FILE --help"
