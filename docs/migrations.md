# Migrations

schema-pop generates **codec-level migrations**: given two versions of a
schema, it emits code that converts a `v1`-shaped value into a `v2`-shaped
value, running through the generated codecs at the byte level.

```
v1 bytes → deserialize (v1 codec) → v1 object → transform → v2 object → serialize (v2 codec) → v2 bytes
```

The mechanical part (copy, rename, widen, default-init, nested composition) is
derived automatically from the diff of the two layout plans. Anything
ambiguous (narrowing, structural type changes, new fields with no safe default)
is filled by **plain data-transform functions** you supply — schema-pop refuses
to generate until every ambiguous change is covered, so it never emits
silently-wrong data.

## Workflow

Migrations use the imperative API, alongside `fromModule` / `analyze` /
`exportPlan`. You give it two analyzed plans; it gives you a TypeScript module.

```ts
import {
  fromModule,
  SchemaAnalyzer,
  diffPlans,
  resolveMigration,
  emitTsMigration,
} from "@schema-pop/core";
import * as v1Schema from "./schema.1";
import * as v2Schema from "./schema.2";

// 1. Analyze both versions into layout plans.
const from = new SchemaAnalyzer().analyze(fromModule(v1Schema.$.export()), {
  version: "1.0.0",
}).plan;
const to = new SchemaAnalyzer().analyze(fromModule(v2Schema.$.export()), {
  version: "2.0.0",
}).plan;

// 2. Diff → classify every change (auto vs needs-a-hook).
const diff = diffPlans(from, to);

// 3. Resolve into a migration plan. Throws MigrationError (with a punch-list)
//    if any ambiguous change lacks a hook.
const plan = resolveMigration(diff, hooks /* optional, see below */);

// 4. Emit the TypeScript migration module.
const code = emitTsMigration(plan, {
  v1TypesImport: "./v1/schema",
  v2TypesImport: "./v2/schema",
  v1CodecImport: "./v1/codec",
  v2CodecImport: "./v2/codec",
  hooksImport: "./migrations.hooks", // omit if the migration is fully automatic
});
// write `code` next to your generated v1/v2 codecs.
```

`diffPlans` and `emitTsMigration` take **any two plans** — you decide which pair
to migrate. Chaining `v1 → v3` is your composition (`transformV3(transformV2(x))`).

## What gets emitted

For each migrated type, `emitTsMigration` produces two functions:

```ts
// Pure object transform — the "function modifying data".
export function transformBattery(v1: V1.Battery): V2.Battery { ... }

// Byte wrapper — deserialize (v1 codec) → transform → serialize (v2 codec).
export function migrateBattery(v1Bytes: Uint8Array): Uint8Array { ... }
```

Use `migrate<T>` when you have raw bytes; use `transform<T>` when you already
have decoded objects (or want to compose/unit-test the conversion).

The byte wrapper is emitted only for **fixed-size** types. Variable-size types
(containing strings or dynamic arrays) get `transform<T>` plus a comment — run
your own (de)serialization around it, since the output length isn't known ahead
of time.

## Auto-derived changes

Detected from the plan diff, no hook needed:

| Change                          | How it migrates                        |
| ------------------------------- | -------------------------------------- |
| Field unchanged / reordered     | copied by name                         |
| Field renamed (via `Renamed`)   | copied from the old name               |
| Field widened (`u8 → u16`, …)   | copied (identity at the value level)   |
| Field removed                   | dropped                                |
| Field added with ArkType default| filled with the default literal        |
| Field added (primitive/str/arr) | filled with a zero value (`0`/`""`/`[]`)|
| Field references a changed type  | calls that type's `transform` (nested) |
| Type / field / variant unchanged | identity                              |

### Markers

**Rename** — `Renamed<T, "oldName">`. Without it, a rename looks like
(removed, added) and the old value is dropped. Add `Renamed` to your scope so
the string form resolves:

```ts
import { scope } from "arktype";
import { binary, Renamed } from "@schema-pop/schema";

export const $ = scope({
  ...binary.import(),
  Renamed,
  Battery: {
    voltage: "Renamed<u32, 'voltage_mv'>", // was `voltage_mv` in v1
    current: "i32",
  },
});
```

The marker is metadata only — the v2 layout is identical to the un-marked
version; the old name is remembered for the migration step alone. (The same
applies to `Obsolete`, `Scale`, etc. — marker generics you add to your scope no
longer leak into the generated output.)

**Defaults for new fields** — use ArkType's native default syntax; no custom
marker:

```ts
Battery: {
  voltage: "Renamed<u32, 'voltage_mv'>",
  firmware: "u16 = 1", // new in v2 — migration fills 1
}
```

## Hooks — your logic in the migration

Changes that can't be resolved mechanically require a hook: **narrowing**
(`u32 → u16`, needs a clamp), **structural type changes**, **new fields with no
safe default** (references/nested structs), and **union/enum/alias changes**.

Write hooks with `defineMigration`, keyed by the **v2 type name**, and pass the
registry to `resolveMigration` (which inspects it for coverage) and point the
emitter at the module that exports it.

```ts
// migrations.hooks.ts
import { defineMigration } from "@schema-pop/core";
import type { V1, V2 } from "./types";

export const migrationHooks = {
  // Per-field mapper — only the fields auto can't derive; the rest fall through.
  Battery: defineMigration<V1.Battery, V2.Battery>({
    current: (v1) => Math.min(v1.current, 65535), // narrowing → clamp
  }),

  // Whole-type escape hatch — one function owns the entire conversion.
  Device: defineMigration<V1.Device, V2.Device>((v1) => ({
    id: v1.id,
    status: reinterpret(v1.raw),
  })),
};
```

- **Per-field mapper** `{ field: (v1) => value }` — override just the ambiguous
  fields; everything else is still auto-derived.
- **Whole-type mapper** `(v1) => v2` — you write the entire object; markers and
  defaults are not consulted for that type.

`resolveMigration` inspects the registry's shape at generation time (a
per-field mapper's own keys, or a whole-type function covering everything) to
decide coverage — it does **not** run your functions during generation.

## The hard error (no silent gaps)

If any ambiguous change has no matching hook, `resolveMigration` throws a
`MigrationError` listing every gap — generation refuses:

```
MigrationError: Cannot auto-generate migration — 2 change(s) need a user hook:
  - Battery: field 'current' narrowed — needs a clamp/validation — add "current" to defineMigration
  - Device: field 'serial' changed type structurally — add "serial" to defineMigration
Provide the missing logic via defineMigration(...) and pass it to resolveMigration.
```

Fix by adding the named field/type to your hooks and re-running. schema-pop
never emits a stub that returns wrong-but-valid data.

## Limitations (current)

These fall through to "provide a whole-type hook" or a clear error today:

- **Union / enum / alias changes** — auto transforms aren't generated yet;
  supply a whole-type `defineMigration<...>((v1) => ...)`. Unchanged
  unions/enums/aliases pass through as identity.
- **Enum-variant rename** — the `Renamed` marker isn't yet wired for enum
  variants (they come from string-literal options); a renamed variant reads as
  (removed, added).
- **`array`/`optional` of a changed struct** — nested composition currently
  covers direct (scalar) references; an array or optional wrapping a changed
  type asks for a hook rather than auto-mapping each element.
- **Backwards / multi-step migrations** — pairwise and forward only; compose
  chains yourself.
