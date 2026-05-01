# Versioning & migrations

Schemas evolve. `schema-pop` lets you ship multiple versions of one schema side by side, with each version compiled to a separate namespace/module so they coexist in one output file.

## Workflow

1. **Snapshot** — keep each version as its own source file (e.g. `test-schema.ts` for v1.0, `test-schemaV2.ts` for v2.0). The `create-schema-pop` scaffold groups files by base name automatically: `<base>.ts` → 1.0, `<base>V<n>.ts` → `<n>.0`.
2. **Register** — declare versions in `pop.config.ts`:

   ```ts
   schemas: [{
       name: "test-schema",
       versions: [
           { version: "1.0", source: "./src/test-schema.ts" },
           { version: "2.0", source: "./src/test-schemaV2.ts" },
       ],
       targets: [ /* … */ ],
   }]
   ```

3. **Generate** — `bun run generate` produces all versions in each target output:

   - Rust: `pub mod test_schema_1_0 { … }` and `pub mod test_schema_2_0 { … }`
   - C++: `namespace test_schema_1_0 { … }`
   - Zig: `pub const test_schema_1_0 = struct { … }`
   - TypeScript: `export namespace test_schema_1_0 { … }`
   - HTML: a single page with both versions, side-by-side compare overlay, and a per-type diff summary

   Within one output, each version's struct types use the namespaced safe identifier (`test_schema_1_0_BatteryInfo` etc.) so name collisions across versions are impossible.

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

> **Status (0.1):** code-generation of migration functions (e.g. `impl From<v1::T> for v2::T`) is not yet shipped. The 0.2 milestone adds custom-migration hooks; until then, the diff view is the primary support for tracking schema evolution.

For now, when you need to migrate data between versions, the typed structs from each namespace are available side by side and you can write the migration logic by hand using the existing pre-computed layout.
