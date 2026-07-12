# Writing your own exporter

An exporter takes a `LayoutPlan` (the analyzer's pre-computed memory map) and emits source code for one target language or format. Exporters are **stateless plugin functions**: no compiler hooks, no runtime, no inheritance — just a function that returns an object matching the `ExporterPlugin` interface.

This guide walks through the interface, the data you receive, and a minimal example.

---

## 1. The interface

```ts
import type { LayoutPlan, ExporterPlugin, BaseConfig } from "schema-pop";

export interface ExporterPlugin<TConfig extends BaseConfig = BaseConfig> {
    name: string;
    config: TConfig;

    /** Emit code for a single version. Return either a single string
     *  (concatenated per `dest`) or a Record<filename, content> for
     *  multi-file output. */
    generate: (plan: LayoutPlan) => string | Record<string, string>;

    /** Wrap a single version's code with a namespace/module so multiple
     *  versions of the same schema can coexist in one output file. */
    wrapVersion?: (version: string, code: string) => string;

    /** Per-output-file header. Emitted once before any version body. */
    getFileHeader?: () => string;

    /** Per-output-file footer. Emitted once after the last version body. */
    getFileFooter?: () => string;

    /** Emit auxiliary files alongside the main output — buildable
     *  harnesses, package.json, build scripts, anything. Receives all
     *  versioned plans for the schema. */
    getHarness?: (plans: LayoutPlan[]) => Record<string, string>;
}
```

A typical exporter is a **factory function** that takes user config and returns the plugin:

```ts
import type { LayoutPlan, ExporterPlugin, BaseConfig } from "schema-pop";

export interface MyConfig extends BaseConfig {
    namespace?: string;
}

export function myLang(config: MyConfig): ExporterPlugin<MyConfig> {
    const cfg: MyConfig = { commentStyle: "slash", ...config };
    return {
        name: "my-lang",
        config: cfg,
        generate: (plan) => {
            // … render plan …
        },
    };
}
```

`BaseConfig` covers shared options every exporter understands: `dest`, `fieldNaming`, `typeNaming`, `commentStyle`, `prependToFile`, `appendToFile`, `noHeader`, `noWrap`.

---

## 2. The input: `LayoutPlan`

The analyzer pre-computes everything you need. **Never recalculate offsets, alignment, or padding** — render only what's already in the plan.

```ts
type LayoutPlan = {
    version: string;          // e.g. "test_schema_1_0" — already a safe identifier
    endian: "le" | "be";
    wordSize: 32 | 64;
    autoSort: boolean;
    types: TypePlan[];
};

type TypePlan = StructPlan | UnionPlan | EnumPlan | AliasPlan;
```

Every `TypePlan` has `name`, `kind`, `size`, `align`, `paddedSize`. Optional `description` (from `Describe<>`) and `obsolete` / `obsoleteReason` (from `Obsolete<>`).

### `StructPlan`

```ts
{
    kind: "struct",
    name: string,
    fields: FieldPlan[],
    size, align, paddedSize,
}

type FieldPlan = {
    name: string,
    type: Field,            // see below
    offset: number,         // byte offset within the struct
    bitOffset: 0..7,        // 0 unless inside a packed-bit field
    bitSize: number,        // size in bits
    size: number,           // size in bytes
    paddingAfter: number,   // bytes of padding after this field; emit explicitly
    description?: string,
    obsolete?: boolean,
    obsoleteReason?: string,
};
```

### `UnionPlan` (tagged union)

```ts
{
    kind: "union",
    name, size, align, paddedSize,
    tagOffset: number,
    tagSize: number,
    tagType: "u8" | "u16" | "u32",
    variants: { name: string, type: Field }[],
}
```

### `EnumPlan`

```ts
{
    kind: "enum",
    name, size, align,
    underlyingType: "u8" | "u16" | "i32",
    variants: { name: string, value: number }[],
}
```

### `AliasPlan`

```ts
{
    kind: "alias",
    name, size, align,
    type: Field,            // what this name aliases
}
```

### `Field` (recursive field type)

```ts
type Field =
  | { kind: "primitive", name: "u8" | "i32" | …, size, align, paddedSize, bitSize?, popKind }
  | { kind: "reference", name: string }              // points to another top-level type
  | { kind: "array", item: Field, exactLength? | maxLength? }
  | { kind: "string", maxLength? }
  | { kind: "optional", inner: Field }
  | { kind: "inlineStruct", fields: FieldPlan[], size, align, paddedSize }
  | { kind: "unit" };                                // for "literal" union variants
```

For exporters that target ABI-strict native code (Rust / C++ / Zig), the safe pattern for non-scalar fields is to fall back to an opaque byte array of the right size (`[u8; size]`), preserving layout without committing to full type fidelity.

---

## 3. Multi-version output

When users ship multiple versions of the same schema, the builder calls `generate(plan)` once per version. You handle multi-version output via `wrapVersion`:

```ts
wrapVersion: (version, code) => `pub mod ${version} {\n${indent(code)}\n}\n`,
```

The `version` string is already a safe identifier (e.g. `test_schema_1_0`).

For single-file targets like HTML, you can instead emit per-version `<script>` data injections from `generate()` and let the runtime stitch them together.

---

## 4. File assembly

The builder writes one file per `targetConfig.dest`. For each file it concatenates:

1. `renderComment(commentStyle, "AUTO GENERATED…")` (skipped when `commentStyle === "none"`)
2. `getFileHeader()`
3. `prependToFile`
4. for each version: `wrapVersion(version, generate(plan))` (or just `generate(plan)` if no `wrapVersion`)
5. `appendToFile`
6. `getFileFooter()`

`getHarness(plans)` is called **once per file** with all the versioned plans, and writes its returned files alongside the main output. Use it for buildable test harnesses (`Cargo.toml`, `package.json`, `main.rs`, etc.) — see `packages/exporter/src/exporters/rustHarness.ts` for a reference implementation.

---

## 5. `generate()` return shapes

- **`string`** — concatenated into the file at `dest`.
- **`Record<string, string>`** — each entry written to `dirname(dest) + "/" + key`. Useful when one schema produces many small artifacts (one SVG per type, etc.).

---

## 6. The `ExporterTools` helper kit

For naming, indentation, namespace wrapping, primitive mapping — use the shared kit so your exporter behaves like the built-ins:

```ts
import { ExporterTools } from "schema-pop";

const { typeName, fieldName, indent, mapScalarField, wrapNamespace } =
    ExporterTools(cfg);
```

- `typeName(name)` / `fieldName(name)` — pre-bound to `cfg.typeNaming` / `cfg.fieldNaming`
- `mapScalarField(field, primitiveMap, refResolver, fallback?)` — resolves primitives + references; returns `undefined` for kinds your exporter must recurse into (array / optional / string / inlineStruct / unit)
- `wrapNamespace(version, body, { open, close, indent? })` — convenience wrapper around `wrapVersion`
- `indent(n, code)` — indents every line of `code` by `n` tabs

---

## 7. Minimal example

A toy "JSON struct dump" exporter:

```ts
import type { LayoutPlan, ExporterPlugin, BaseConfig } from "schema-pop";
import { ExporterTools } from "schema-pop";

export interface JsonDumpConfig extends BaseConfig {}

export function jsonDump(config: JsonDumpConfig): ExporterPlugin<JsonDumpConfig> {
    const cfg = { commentStyle: "none", ...config };
    const { typeName, fieldName } = ExporterTools(cfg);
    return {
        name: "json-dump",
        config: cfg,
        generate: (plan: LayoutPlan) => {
            const out: any = { version: plan.version, types: [] };
            for (const t of plan.types) {
                if (t.kind !== "struct") continue;
                out.types.push({
                    name: typeName(t.name),
                    size: t.size,
                    align: t.align,
                    fields: t.fields.map((f) => ({
                        name: fieldName(f.name),
                        offset: f.offset,
                        size: f.size,
                        pad: f.paddingAfter,
                    })),
                });
            }
            return JSON.stringify(out, null, 2) + "\n";
        },
        wrapVersion: (version, code) =>
            `// version: ${version}\n${code}`,
    };
}
```

Use it like any built-in exporter — call the factory and write its output:

```ts
import { fromModule, SchemaAnalyzer } from "@schema-pop/core";
import { jsonDump } from "./my-exporter";
import { $ } from "./telemetry.1"; // an ArkType module

const { plan } = new SchemaAnalyzer().analyze(fromModule($.export()), {});
await Bun.write(
    "./dist/telemetry.json",
    jsonDump({ dest: "./dist/telemetry.json" }).generate(plan),
);
```

---

## 8. Reference exporters

The code under `packages/exporter/src/exporters/` is the canonical reference:

- `rust.ts` / `rustHarness.ts` — full ABI-safe target, struct/enum/union/alias, opaque byte fallback, `#[deprecated]`, buildable harness
- `ts.ts` / `tsCodec.ts` — JSDoc emit, binary codec glue, `LAYOUT_PLAN` JSON dump
- `cpp.ts`, `zig.ts` — same shape as Rust, language-specific deprecation
- `svg.ts` — `Record<string, string>` output mode (one SVG per type), CSS-var-driven theming
- `html.ts` + `htmlApp.ts` — single self-contained docs site

Read those when you need to see how something nontrivial is done.

---

## 9. Constraints to respect

- **Don't compute offsets or alignment.** The analyzer already did. Render only what's in the plan.
- **Emit padding explicitly.** When `f.paddingAfter > 0`, emit a reserved field (`uint8_t _pad_x[N]`, `pub _pad: [u8; N]`) so the layout matches across compilers.
- **Topological order is already done.** Types come pre-sorted; references will always be defined before use.
- **Respect naming strategies.** Use `typeName` / `fieldName` from `ExporterTools` rather than the raw schema names.
- **Don't add a runtime.** Generated artifacts must work with no dependency on `schema-pop` at runtime.

That's it — that's the whole API.
