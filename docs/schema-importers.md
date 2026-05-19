# Schema importers

Importers parse source files from various languages and produce a `LayoutPlan` — the
schema-pop intermediate representation that all exporters consume.

---

## 1. Tree-sitter

Package: `@schema-pop/importer`

Parses source files using [tree-sitter](https://tree-sitter.github.io/) WebAssembly grammars.
Each language has a dedicated walker that extracts struct/class/type definitions and maps
them to `LayoutPlan` types. Walkers share a common `emit.ts` layer for field resolution
and offset calculation.

| Language    | Walker           | WASM source              |
| ----------- | ---------------- | ------------------------ |
| C           | `walk-c.ts`      | `tree-sitter-c`          |
| C++         | `walk-cpp.ts`    | `tree-sitter-cpp`        |
| C#          | `walk-csharp.ts` | `tree-sitter-c-sharp`    |
| Dart        | `walk-dart.ts`   | `tree-sitter-dart`       |
| Elixir      | `walk-elixir.ts` | `tree-sitter-elixir`     |
| Go          | `walk-go.ts`     | `tree-sitter-go`         |
| Java        | `walk-java.ts`   | `tree-sitter-java`       |
| Kotlin      | `walk-kotlin.ts` | `tree-sitter-kotlin`     |
| Objective-C | `walk-objc.ts`   | `tree-sitter-objc`       |
| PHP         | `walk-php.ts`    | `tree-sitter-php`        |
| Python      | `walk-python.ts` | `tree-sitter-python`     |
| Rust        | `walk-rust.ts`   | `tree-sitter-rust`       |
| Scala       | `walk-scala.ts`  | `tree-sitter-scala`      |
| Swift       | `walk-swift.ts`  | `tree-sitter-swift`      |
| TypeScript  | `walk-ts.ts`     | `tree-sitter-typescript` |

WASM binaries for all 15 languages ship with the package and are loaded on demand —
only the grammars actually used in a given run are initialized.

---

## 2. Clang

Package: `@schema-pop/clang-importer` _(wip)_

Tree-sitter C/C++ walkers cover the common case but have inherent limits: they operate
on raw text without a preprocessor or type system, so macros, `typedef` chains, platform
`#ifdef` guards, and complex template instantiations can produce incorrect or incomplete
layouts. Clang solves this by compiling the source with a real toolchain and reading the
resulting AST via `libclang` (or the Clang JSON AST dump), giving exact sizes, alignments,
and offsets as the target compiler sees them.

Use Clang when:

- the header relies heavily on preprocessor macros for type aliases or sizes
- `__attribute__((packed))` / `#pragma pack` is in play
- cross-compilation targets (different word size, endianness, or ABI) need to be matched exactly
- C++ templates or partial specialisations are involved

---

## 3. Gimli

Package: `@schema-pop/gimli-importer` _(TBD)_

…
