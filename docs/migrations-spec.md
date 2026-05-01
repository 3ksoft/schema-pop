# Migrations — design spec

> **Status:** design draft. The 0.1 line ships only the HTML diff view
> (`generateMigration` for documentation). This spec lays out what
> `schema-pop` 0.2 will emit as code, and how users hook into it.
>
> Companion doc: [`versioning-and-migrations.md`](./versioning-and-migrations.md)
> (user-facing workflow, what already works in 0.1).

---

## Goals

1. Given two layout plans `from` and `to`, emit code that converts a
   `from`-shaped value to a `to`-shaped value in each enabled target
   language. `migrate_<Type>_v1_to_v2(input) -> output`.
2. Cover the **safe / mechanical** changes automatically (field added,
   removed, widened, reordered, union variant added).
3. For **ambiguous** changes (rename, type change, narrowing, variant
   removal), require explicit markers in the schema or hook overrides
   in `pop.config.ts`.
4. Stay honest: when the analyzer can't classify a change, generate a
   stub that fails at runtime with a clear message — never silently
   produce wrong data.

## Non-goals

- **Backwards migrations** (v2 → v1). Out of scope; covered by writing
  a separate v2-to-v1 schema if the user really needs it.
- **Multi-step migration chaining** (v1 → v3 via v2). Out of scope; the
  user composes pairwise migrations themselves.
- **Database / on-disk migration**. We only emit value-level converters.
  Storage migration (read old bytes, write new bytes) is a separate
  exporter.
- **Streaming / partial migration**. Whole-value converters only.

---

## Change taxonomy

Every difference between `from` and `to` falls into one of these
categories. The analyzer classifies each, then dispatches to the right
emit strategy.

| # | Change                          | Auto-detect? | Marker required?              | Custom hook needed? |
| - | ------------------------------- | ------------ | ----------------------------- | ------------------- |
| 1 | Field added                     | yes          | — (use ArkType `"T = value"`) | only if no default  |
| 2 | Field removed                   | yes          | —                             | no                  |
| 3 | Field renamed                   | **no**       | `Renamed<T, "oldName">`       | no                  |
| 4 | Field reordered                 | yes          | —                             | no                  |
| 5 | Field type widened (u8→u16, etc.) | yes          | —                             | no                  |
| 6 | Field type narrowed (u32→u16)   | partial      | —                             | yes (user opts in)  |
| 7 | Field type structurally changed | no           | —                             | **yes**             |
| 8 | Type renamed                    | **no**       | `Renamed<{...}, "OldType">`   | no                  |
| 9 | Type added                      | yes          | —                             | no (no inputs)      |
| 10 | Type removed                    | yes          | —                             | no                  |
| 11 | Union variant added             | yes          | —                             | no                  |
| 12 | Union variant removed           | partial      | `Obsolete` recommended        | yes (handle gracefully) |
| 13 | Union variant renamed           | **no**       | `Renamed<...>` on variant     | no                  |
| 14 | Enum variant added/removed/renamed | same as union variants                                |
| 15 | Constraint relaxed (range expanded) | yes      | —                             | no                  |
| 16 | Constraint tightened              | partial    | —                             | yes (validate)      |

**Auto-detect** = analyzer can pair `from` and `to` without any user
hint. Pairing rule: same `name` at the same nesting level. If a name
disappears in `to`, it's *removed*; if a new name appears, it's *added*.
Without explicit `Renamed`, a rename looks like (removed, added) — the
old value is dropped and the new one gets a default.

---

## Markers

Markers are arktype generics defined in the `core` scope, alongside
existing `Obsolete<T, "reason">`. They live in the schema source so
the analyzer can extract them deterministically — no separate config
needed for the common cases.

### `Renamed<T, "oldName">`

Tells the analyzer: "in v2, this field/type/variant *is* the same
thing that was called `oldName` in v1." Without this marker, a rename
is indistinguishable from "old removed, new added", and the migration
would discard the old value.

```ts
// v1
BatteryInfo: { voltage_mv: "u32", current: "i32" }

// v2
BatteryInfo: {
    voltage: "Renamed<u32, 'voltage_mv'>",   // ← was voltage_mv
    current: "i32",
}
```

Emits:

```ts
// TS migration
function migrate_BatteryInfo_v1_to_v2(v1: V1.BatteryInfo): V2.BatteryInfo {
    return {
        voltage: v1.voltage_mv,
        current: v1.current,
    };
}
```

`Renamed` at type level (less common, more useful for UnionPlan and
EnumPlan):

```ts
// v1
DeviceStatus: "'Idle' | 'Active' | 'Error'"

// v2
RuntimeStatus: "Renamed<'Idle' | 'Active' | 'Error' | 'Suspended', 'DeviceStatus'>"
```

Emits a top-level `migrate_DeviceStatus_v1_to_RuntimeStatus_v2` (or
similar; exact naming is exporter-specific).

### Defaults: use ArkType, not a custom marker

For "field is new in v2, fill with X when migrating up", we **don't**
ship a `Default<T, value>` marker. ArkType already has first-class
default syntax and the analyzer already reads it:

```ts
// v2
BatteryInfo: {
    voltage: "Renamed<u32, 'voltage_mv'>",
    current: "i32",
    firmware_version: "u16 = 1",   // ArkType default — used for migration
}
```

The migration emitter pulls the default from the ArkType node (same
mechanism that already feeds runtime parsing) and inlines it for
new-field migrations. For nested types or computed defaults that
ArkType can't express literally, fall through to a custom hook.

### Marker rules

- `Renamed<T, name>` applies per migration step (between consecutive
  versions). The marker reflects *what changed going into this version*,
  not the entire history.
- The marker disappears in subsequent versions (a v3 reference to
  `voltage` doesn't need to know it was `voltage_mv` in v1; v2's
  migration carries that knowledge).
- `Renamed` composes with `Obsolete<T, "reason">` and ArkType's
  `"T = value"` defaults — orthogonal annotations on the same field.
- Markers are **per-target** invisible — they affect IR only. The
  emitted struct in v2 is just `voltage: u32`; the original name is
  remembered for the migration step only.

---

## Per-language extension: native mechanism, no central hook config

For changes the analyzer can't auto-classify (structural type change,
narrowing with validation, variant removal, custom unit conversions),
the user provides the missing logic in their **own** code, in the
**target language's idiomatic form**. Schema-pop never pastes blobs
of foreign-language source from `pop.config.ts`. Each language uses
its native extension mechanism — *no magic*.

### TS — `defineMigration` helper

Schema-pop ships a small runtime helper. The user writes a typed
object in a regular `.ts` file. Full inference, full editor support,
debugger steps in, all the usual things.

```ts
// src/migrations.ts (user code)
import { defineMigration } from "schema-pop/runtime";
import type { V1_0, V2_0 } from "./generated/battery";

export const batteryV1V2 = defineMigration<V1_0.BatteryInfo, V2_0.BatteryInfo>({
    voltage: (v1) => v1.voltage_mv,
    firmwareVersion: (v1) => detectFw(v1),
});
```

`defineMigration` accepts a *partial* per-field mapper. Fields you
don't list fall through to schema-pop's auto-detection — so you only
write what auto can't figure out.

```ts
// pop.config.ts — single line per language pointing at user code
migrations: { ts: { module: "./src/migrations" } }
```

The generated dispatcher imports from that module and dispatches by
`(typeName, fromVersion, toVersion)`. Type without auto migration AND
without a user entry → dispatcher throws at runtime with the change
description. Never silently wrong.

### Rust — `impl From`, no helper required

Rust's trait system *is* the extension mechanism. Schema-pop generates
`impl From<v1_0::T> for v2_0::T` only for fully-auto types. For the
rest, the user writes their own impl in their own crate:

```rust
// src/migrations.rs (user code)
impl From<v1_0::SerialNumber> for v2_0::SerialNumber {
    fn from(v1: v1_0::SerialNumber) -> Self {
        v2_0::SerialNumber { /* ... */ }
    }
}
```

Coherence rules guarantee no double-impl: schema-pop *omits* the impl
for non-auto types and emits a single comment line in the generated
file as a hint:

```rust
// schema-pop: write `impl From<v1_0::SerialNumber> for v2_0::SerialNumber` yourself
//   (reason: field 'bytes' has incompatible type change u32 -> [u8; 16])
```

Missing `From` impls become compile errors wherever code calls
`.into()`. Fail fast, fail loud. `pop.config.ts` needs nothing for
Rust — convention only.

### C / C++ — header decl always; body conditional

Schema-pop always emits a forward declaration in the generated
header. Bodies for auto-able migrations go in the generated `.c` /
`.cpp`. For non-auto, only the decl is emitted — the user implements
the body in their own translation unit, the linker resolves at build
time.

```c
// generated header — every type gets a decl
void migrate_BatteryInfo_v1_0_to_v2_0(const v1_0_BatteryInfo *src,
                                       v2_0_BatteryInfo *dst);

void migrate_SerialNumber_v1_0_to_v2_0(const v1_0_SerialNumber *src,
                                        v2_0_SerialNumber *dst);
//  ^ schema-pop: implement in your own .c — no auto-migration available
```

Missing implementations become linker errors — same fail-fast story
as Rust. C++ uses the same pattern in a namespace; conversion
constructors are *not* emitted (binding to type identity surprises
users when the conversion lives outside the type's TU).

`pop.config.ts` for C / C++ — convention only.

### Zig — module composition

Schema-pop emits `migrations.zig` with auto bodies. For non-auto
types, schema-pop emits a stub function in `migrations.user.template.zig`
as starting source the user copies once and edits:

```zig
// migrations.user.template.zig — copy to migrations.user.zig and fill in
pub fn migrate_SerialNumber_v1_0_to_v2_0(src: v1_0.SerialNumber) v2_0.SerialNumber {
    @compileError("schema-pop: user-supplied migration not implemented");
}
```

Generated `migrations.zig` does
`pub usingnamespace @import("migrations.user.zig");` — user file
fills in the missing functions. Compile-time error if the function
isn't there.

```ts
// pop.config.ts
migrations: { zig: { userModule: "./migrations.user.zig" } }
```

### Field-level overrides

For "the type as a whole is fine, just one field needs custom logic"
(unit conversion, computed defaults, narrowing with clamping), the
per-language mechanism still applies, just at field granularity:

- **TS:** `defineMigration` already supports partial field mappers;
  list only the fields you want to override.
- **Rust:** the hand-written `impl From` *is* field-granular by
  definition (you write the whole struct literal anyway).
- **C / C++ / Zig:** when you implement the function body, you control
  every field. No separate field-level hook config.

The function itself is the hook.

### Targets without migrations

WGSL, GLSL, SVG, HTML, OpenAPI, Brainfuck — schema-pop emits nothing
migration-related. HTML keeps its existing diff view (renamed / added /
removed cosmetic info, no executable code).

### Precedence

Per language, highest first:

1. User-supplied implementation (TS `defineMigration` entry / Rust
   `impl From` / C body in user `.c` / Zig user module function).
2. `Renamed<T, "oldName">` marker (rename a field, otherwise auto).
3. ArkType default (`"T = value"`) for a new field.
4. Auto-detection (zero / empty / structural copy / widen / reorder).

A user-supplied impl is all-or-nothing for its type — the contract is
"you write the body, you handle every field." Markers and ArkType
defaults stop being consulted for that type once a user impl exists.

---

## What gets emitted

For each (Type, fromVersion, toVersion) where schema-pop can fully
auto-derive a migration, the relevant exporter emits the complete
conversion. For types schema-pop cannot fully derive, it emits *only*
the artifacts that turn the user's missing impl into a hard error
(linker error / compile error / runtime throw) — never a silent gap.

Targets covered: **TS, Rust, C, C++, Zig.**

### TS — auto bodies in a namespace + dispatcher

```ts
// fully-auto type — full body emitted
export namespace migrations {
    export function migrate_BatteryInfo_v1_0_to_v2_0(v1: v1_0.BatteryInfo): v2_0.BatteryInfo {
        return { /* auto body */ };
    }
}
```

A top-level `migrate(typeName, fromVersion, toVersion, value)`
dispatcher composes auto entries with user-defined ones from the
configured `migrations.ts.module` and is type-narrowed via overloads.
Non-auto type with no user entry → throws.

### Rust — auto `impl From` only; user adds their own

```rust
// auto-able
impl From<v1_0::BatteryInfo> for v2_0::BatteryInfo {
    fn from(v1: v1_0::BatteryInfo) -> Self { /* auto body */ }
}

// non-auto: schema-pop emits the comment hint and SKIPS the impl
//   coherence guarantees no collision with the user's hand-written impl
```

### C / C++ — split header + .c

```c
// header — every type gets a decl
void migrate_BatteryInfo_v1_0_to_v2_0(const v1_0_BatteryInfo *src,
                                       v2_0_BatteryInfo *dst);

// generated .c — only auto-able types get a body
void migrate_BatteryInfo_v1_0_to_v2_0(const v1_0_BatteryInfo *src,
                                       v2_0_BatteryInfo *dst) {
    /* auto body */
}
```

C++ same shape, in namespace.

### Zig — auto module + user override

```zig
// migrations.zig — generated
pub fn migrate_BatteryInfo_v1_0_to_v2_0(src: v1_0.BatteryInfo) v2_0.BatteryInfo {
    /* auto body */
}
pub usingnamespace @import("migrations.user.zig");
```

Plus a one-shot `migrations.user.template.zig` with stub functions
the user copies once.

### Build summary

After every build, schema-pop prints which migrations are auto and
which need user impls:

```
[schema-pop] migrations:
  ✓ 12 auto-derived
  ⚠  3 require user-supplied impl:
     - rust: SerialNumber  v1.0 → v2.0  (field 'bytes': u32 → [u8; 16])
     - ts:   BatteryInfo   v1.0 → v2.0  (constraint tightened on 'voltage')
     - zig:  DeviceConfig  v1.0 → v2.0  (variant 'Legacy' removed)
```

Same content emitted as a comment block at the top of each generated
migration file so the user has a checklist next to the code.

---

## Failure modes

Every failure mode resolves at the **target language's own enforcement
layer** — schema-pop adds no extra validation and no shadow toolchain.

- **Auto-detection fails, user has not provided an impl** —
  - **TS:** dispatcher throws at runtime with the change description.
  - **Rust:** missing `From` impl → compile error wherever the
    migration is called.
  - **C / C++:** missing function body → linker error.
  - **Zig:** missing function in user module → compile error
    (`@compileError` from the seed template if user copied without
    editing).
- **No silent fallthroughs.** Schema-pop never emits a stub that
  returns wrong-but-valid data.
- **No string-blob hooks.** All user code lives in real source files
  in the target language. Editor support, type checking, debugger,
  formatter — all the user's normal toolchain works.
- **Validation failures** (e.g., narrowing) are the user's
  responsibility inside their own impl. Suggested patterns:
  `Result<T, MigrationErr>` in Rust (use `TryFrom` instead of `From`),
  throw in TS, return early with sentinel in C. Schema-pop's contract
  is just "you write the body" — the body's signature and error model
  is the user's call.

## Open questions

1. **Variant removal in unions/enums** — when a v1 value carries a
   variant that v2 doesn't have, the migration must do *something*.
   Strawman: emit `panic!`/`throw` by default; allow a per-variant
   `OnRemoval<...>` marker to specify a fallback variant or a custom
   handler. Decision deferred to implementation.
2. **Defaults for complex types** — ArkType's `"T = value"` covers
   primitives cleanly. For nested structs / unions where the default
   isn't a literal, the user falls through to writing the type's
   migration themselves (TS partial mapper / Rust `From` / etc.).
   Open: do we want schema-pop to emit `Default::default()` (Rust) /
   `{}` (TS) automatically as a "structurally-empty" fallback, or
   require the user to write something even for "just default-init
   the new field"? Strawman: emit the language's default *with a
   build-time warning*, so it's not silent. User can always override.
3. **Consecutive-version requirement** — should migrations only be
   emitted between *adjacent* versions (1.0→2.0, 2.0→3.0) or for
   every pair (1.0→3.0)? Strawman: adjacent only; chain with a
   helper function. User can manually compose if needed.
4. **Renamed type identity for HTML diff** — the existing diff view
   reports `removed` + `added` for renamed types. With `Renamed`
   markers we should report `renamed` instead. Cosmetic but worth it.
5. **`Renamed` as ArkType generic** — same machinery as `Obsolete<T, "reason">`.
   Need to confirm we can read the literal arg out of `inner` at scope
   level the same way (almost certainly yes — verify when implementing).

---

## Implementation phases

Spec'd top-down so we don't half-ship:

1. **IR**: add `migrationMeta?: { renamedFrom?: string; defaultValue?: unknown }`
   to `FieldPlan` / `TypePlan`. Analyzer fills `renamedFrom` from the
   `Renamed` marker, `defaultValue` from ArkType's native default
   (already accessible via the ArkType node).
2. **`Renamed` marker**: arktype generic in
   `packages/core/src/schema/core.ts`. Analyzer extracts. (No `Default`
   marker — ArkType's `"T = value"` covers it.)
3. **Diff classifier**: function that takes (fromPlan, toPlan) and
   produces a `TypeDiff` per matched type — list of changes from the
   taxonomy above. Each change is tagged `auto` (we can emit body) or
   `user-supplied` (we emit decl/comment/template only).
4. **Per-language emit** (independent, can land separately per target):
   - **TS:** `defineMigration` helper in `@schema-pop/runtime` +
     dispatcher generation in core-exporters that imports user module.
   - **Rust:** `impl From` for auto types; comment-skip for non-auto.
   - **C / C++:** header + `.c`/`.cpp` split with conditional bodies.
   - **Zig:** auto module + `.user.template.zig` seed + `usingnamespace`.
5. **Build summary + per-file checklist comment** — print and embed
   the list of user-required impls so the user has a clear punch list.
6. **Tests**: snapshot suite of v1/v2 schema pairs across all 5 target
   languages. Cover auto cases (rename, widen, ArkType default,
   reorder) + user-impl cases (decl-only / skipped / template).

Phases 1-3 internal (no user-visible output change). Phase 4 is the
bulk and is per-language — TS first as MVP, then Rust, then the rest.
Phase 5 makes the gaps loud. Phase 6 catches regressions.
