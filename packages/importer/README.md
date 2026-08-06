# @schema-pop/importer

Unified `schema-pop-import` CLI that imports Rust / C / C++ source into a
schema-pop arktype scope. Dispatches between two backends:

- **tree-sitter** (bundled wasm grammars, zero runtime deps) — used for Rust
- **system clang** (`-Xclang -ast-dump=json`, requires `clang` on PATH) — used for C / C++

Why split engines: the tree-sitter path is faster and dependency-free, but
purely syntactic. Clang resolves `#include`, `#define`, `__attribute__`,
typedef chains, bitfield widths — much closer to what the user's compiler
actually sees, at the cost of needing clang installed.

## Install

As a global npm tool:

```sh
bun add -g @schema-pop/importer
schema-pop-import file.rs -o file.scope.ts
```

Or run via the workspace without installing:

```sh
bun packages/importer/src/cli.ts file.rs -o file.scope.ts
```

## Usage

```
schema-pop-import <input> -o <output.ts> [options]
schema-pop-import file.h -o out.ts -- -I./inc -DFOO=1   # extra clang flags after `--`
```

Engine + language are inferred from the file extension:

| Extension                           | Lang  | Default engine |
|-------------------------------------|-------|----------------|
| `.rs`                               | rust  | tree-sitter    |
| `.c`, `.h`                          | c     | clang          |
| `.cpp`, `.hpp`, `.cc`, `.cxx`, `.hh`| c++   | clang          |

Override with `-l c++` (force language) or `-e treesitter` (force tree-sitter
even for C / C++ — useful when clang isn't installed).

For C headers that use `uint8_t`/etc. without an explicit `#include <stdint.h>`,
the CLI auto-detects and injects it. Disable with `--no-auto-stdint`.

If your `clang` isn't on `PATH`, point at it: `--clang /opt/clang-22/bin/clang`.

## Extra `Bit` / `Binary` types

For widths or shapes outside the schema-pop standard set (anything beyond
`u1..u7`, `u8..u128`, `f32`/`f64`, `boolean`), define your own scope and pass
it via `-x` (repeatable). The importer:

1. dynamically loads the file,
2. enumerates the scope's keys,
3. adds them to the "known names" set so refs from your source code stay
   as refs (no `unknown` downgrade),
4. injects a matching `import { ... }` + `...scope.import()` into the
   generated output, and
5. silently shadows any same-name typedef from your source (your
   definition wins — the auto-generated one moves to the
   \`// Skipped\` block with a "shadowed by --extras" note).

Example:

```ts
// extras.ts
import { Binary, Bit, scope } from "schema-pop";
export const extras = scope({
  Binary, Bit,
  u9:    "Bit<0 <= number <= 511, 9>",
  fp16:  "Binary<number, 2, 2, 'fp16'>",
  u256:  "Binary<bigint, 32, 8, 'u256'>",
});
```

```sh
schema-pop-import gpu.h -o gpu.scope.ts -x ./extras.ts
schema-pop-import gpu.h -o gpu.scope.ts -x ./extras.ts#extras   # explicit export name
schema-pop-import gpu.h -o gpu.scope.ts -x a.ts -x b.ts          # repeat for several
```

Spec form: `<path>[#exportName]`. Without an export name, the importer
duck-types — picks the first export that quacks like an arktype scope.

## Compile to a native binary

`bun build --compile` produces a single-file executable.

```sh
cd packages/importer
bun run compile                       # current platform → dist/schema-pop-import
TARGET=bun-darwin-arm64 bun run compile   # cross-compile
```

Supported targets (passed verbatim to `bun build --target`):

- `bun-linux-x64`, `bun-linux-arm64`
- `bun-darwin-x64`, `bun-darwin-arm64`
- `bun-windows-x64`

Resulting binary is ~98MB (Bun runtime + wasms + clang importer code).

### Caveat: binary supports clang only today

The compiled binary handles **C / C++ (via system clang)** out of the box.
The **tree-sitter (Rust) path is currently broken inside the binary**
because `web-tree-sitter` loads its runtime `tree-sitter.wasm` via a path
lookup that doesn't survive Bun's bundling. Symptom:

```
failed to asynchronously prepare wasm: ENOENT '/$bunfs/root/tree-sitter.wasm'
```

Workaround for Rust: run the CLI in source mode, where `bun` finds the
wasm files on disk:

```sh
bun packages/importer/src/cli.ts file.rs -o out.ts
```

A proper fix would import each wasm with `with { type: "file" }` so Bun
embeds them with stable paths, plus a `locateFile` callback into
`web-tree-sitter`. Listed as a follow-up — not blocking, since the
clang side is the bigger surface and works fine.

## What it produces

A `.ts` file with `export const $ = scope({ ... })` plus an optional
`export const functions: FunctionPlan[]` for declared functions. The
output uses the same IR + emitter regardless of which engine ran, so
swapping backends doesn't change the schema shape — just the fidelity.
