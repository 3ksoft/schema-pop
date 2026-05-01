# Exporters

Exporters translate the **Linear Layout Plan (LLP)** into source code or auxiliary artifacts. Each is a stateless plugin function (see [writing your own](./exporters/writing_own_exporters.md)).

## Built-in exporters

### `@schema-pop/core-exporters`

| Exporter | Output                            | Notes                                                                  |
| -------- | --------------------------------- | ---------------------------------------------------------------------- |
| `rust`   | `.rs` `#[repr(C, align(N))]`      | Opaque byte fallback for non-scalar fields, optional buildable harness |
| `c`      | `.h` `typedef struct`             | FFI-safe, version-prefixed type names                                  |
| `cpp`    | `.hpp` `struct alignas(N)`        | Bitfield support, optional buildable harness                           |
| `zig`    | `.zig` `extern struct`            | Field-level `align()` for opaque payloads, optional buildable harness  |
| `ts`     | `.ts` interfaces + optional codec | JSDoc comments, optional `PopCodec` glue + `LAYOUT_PLAN` JSON dump     |
| `random` | `.json` randomized fixtures       | Used by the ABI test harness                                           |

### `@schema-pop/extra-exporters`

| Exporter    | Output                          | Notes                                                                |
| ----------- | ------------------------------- | -------------------------------------------------------------------- |
| `html`      | self-contained `.html` docs     | Multi-version sidebar, ⌘K search, compare overlay, inline SVG mem viz |
| `svg`       | one `.svg` per type             | `bars` / `grid` modes, CSS-var-driven theming                        |
| `glsl`      | `.glsl` UBO/SSBO struct         | `std140` / `std430` layout strategies                                |
| `wgsl`      | `.wgsl` storage/uniform struct  | `std140` / `std430` layout strategies                                |
| `openapi`   | OpenAPI 3.0 component schemas   | `deprecated: true` for obsolete types                                |
| `nuxt-ui`   | Form-component example          | Demonstrates schema → UI mapping                                     |
| `brainfuck` | `.bf` + interpreter harness     | Yes, really. Layout-only ABI check via shell wrapper.                |

## Concepts

### Topological ordering

Types in the LLP are pre-sorted so dependencies always come before referencing types. Your exporter can render them in `plan.types` order without checking.

### Naming strategies

Each exporter accepts `fieldNaming` and `typeNaming` from `BaseConfig` (`snake_case` / `camelCase` / `PascalCase` / `original`). This lets `voltage_level` in Rust point to the same byte offset as `voltageLevel` in TypeScript without changing the schema. See [naming-strategies.md](./naming-strategies.md).

### Multi-version output

Exporters that implement `wrapVersion(version, code)` can emit multiple versions of one schema into a single output file (each wrapped in a namespace/module). Exporters without `wrapVersion` only export the latest version.

### Multi-file output

`generate(plan)` can return a `Record<filename, content>` instead of a string. Useful for one-file-per-type targets like SVG.

### Auxiliary files via `getHarness`

`getHarness(plans)` lets an exporter emit buildable test harnesses, package manifests, build scripts, etc. The Rust / C++ / Zig / Brainfuck exporters use this to ship a working ABI test harness alongside the generated structs.

### Deprecation propagation

`Obsolete<T, "reason">` in the schema flows through to language-native deprecation:

- Rust: `#[deprecated(note = "...")]`
- C++: `[[deprecated("...")]]`
- TS: JSDoc `@deprecated reason`
- Zig: `// DEPRECATED: ...` comment
- OpenAPI: `deprecated: true`
- HTML: pill + strikethrough + reason in the field row

## Configuration shape

Every exporter's config extends `BaseConfig`:

```ts
interface BaseConfig {
    dest?: string;             // output path (file or directory)
    fieldNaming?: NamingStrategy;
    typeNaming?: NamingStrategy;
    commentStyle?: "slash" | "star" | "xml" | "hash" | "none";
    prependToFile?: string;
    appendToFile?: string;
    noHeader?: boolean;
    noWrap?: boolean;
}
```

Individual exporters extend this with target-specific options (e.g. `harness: boolean` for Rust/C++/Zig, `mode: "bars" | "grid"` for SVG, `viz: ExporterPlugin` for HTML).
