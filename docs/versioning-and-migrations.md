# Versioning & migrations

Schemas evolve. `schema-pop` lets you ship multiple versions of one schema side by side, with each version compiled to a separate namespace/module so they coexist in one output file.

## Workflow

1. **Snapshot** — keep each version as its own source file. The filename carries the version: `<name>.<version>.pop.ts`. The `create-schema-pop` scaffold and the discovery glob (`./**/*.pop.ts`, see [`config.md`](./config.md)) pick them up automatically.

   ```
   src/test-schema.1.pop.ts
   src/test-schema.2.pop.ts
   ```

2. **Wrap the latest** with `schemaPop({ targets: [...] }, scope({...}))`. Older versions can stay as plain `export const $ = scope({...})` — the builder picks targets from the highest-version file:

   ```ts
   // test-schema.2.pop.ts
   import { schemaPop, scope } from "schema-pop";
   import { rust, html } from "@schema-pop/exporter";

   export const $ = schemaPop(
       { targets: [rust({}), html({})] },
       scope({ ...schemaPop, /* ... */ }),
   );
   ```

3. **Generate** — `bunx schema-pop` produces all versions in each target output:

   - Rust: `pub mod test_schema_1 { … }` and `pub mod test_schema_2 { … }`
   - C++: `namespace test_schema_1 { … }`
   - Zig: `pub const test_schema_1 = struct { … }`
   - TypeScript: `export namespace test_schema_1 { … }`
   - HTML: a single page with both versions, side-by-side compare overlay, and a per-type diff summary

   Within one output, each version's struct types use the namespaced safe identifier (`test_schema_1_BatteryInfo` etc.) so name collisions across versions are impossible. Single-version schemas drop the suffix automatically — see "Single-version namespace" in [`config.md`](./config.md).

## Marking fields as obsolete

Use `Obsolete<T, "reason">` to flag fields or types that are deprecated in a given version. The flag propagates to every exporter:

- Rust: `#[deprecated(note = "...")]`
- C++: `[[deprecated("...")]]`
- TypeScript: JSDoc `@deprecated reason`
- Zig: `// DEPRECATED: ...` comment
- OpenAPI: `deprecated: true`
- HTML docs: `OBSOLETE` pill, strikethrough on the name, reason in the field row

Typical lifecycle: introduce a field, mark it `Obsolete<>` in the version where its replacement appears, remove it in the version after. The HTML diff view marks each transition explicitly.

## Diff view

The `html` exporter implements `generateMigration(fromPlan, toPlan)`. The page's `changes` section summarizes per-type status across consecutive versions:

- **added** — new type in the target version
- **removed** — present in source, absent in target
- **modified** — same name, different size/align/fields/variants/obsolete-state
- **unchanged** — wire-compatible (byte-for-byte identical layout)

The compare overlay (sidebar → "compare versions") lets you diff any two versions field-by-field with both memory-layout SVGs side by side.

## Code-level migration helpers

The Rust, C++, Zig, and Go exporters implement `generateMigration(fromPlan, toPlan)` and emit per-type conversion functions between consecutive versions in their respective output files (`migrate_T_v1_to_v2(src) -> T`). Auto-derivable changes (added field with default, renamed via `Renamed<T, "oldName">`, type widening, reorder) get full bodies; ambiguous changes (narrowing, structural type changes) emit a stub the user fills in. See [`migrations-spec.md`](./migrations-spec.md) for the change taxonomy and per-language emit shapes.
