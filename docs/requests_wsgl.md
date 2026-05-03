# Requests / observations from pajonk integration (WGSL exporter)

Running list of feature requests and pain points surfaced while evaluating
schema-pop as a single source of truth for the GPU physics kernel in
[pajonk](https://github.com/krybak/pajonk) (XPBD + MLS-MPM, WebGPU). Pajonk
currently maintains the same struct shapes in three places:

1. WGSL — `src/physics/wgsl/structs.wgsl`
2. JS encoder — `src/physics/PhysicsState.ts` (`setParticle`, `setConstraint`)
3. Buffer offset table — `src/physics/Physics.ts:init` + `docs/gpu_buffers.md`

The CLAUDE.md note for that project literally reads *"there is no single source
of truth"*. Schema-pop is the obvious candidate; this doc lists what it would
need to actually fill that role.

Priority levels:

- **Blocking** — without this, schema-pop cannot replace pajonk's hand-written
  WGSL. We'd have to keep the hand-written file as the source of truth.
- **Problem** — real bug or significant UX issue but doesn't block adoption;
  workarounds exist (or already in use).
- **Nice to have** — improvements that don't block anything but would raise the
  generated output's quality.

---

## Blocking

### B1 — `atomic<T>` qualifier support

Pajonk's `xpbd_forces` is an atomic accumulator buffer (`array<atomic<u32>, ...>`)
written from many threads in the constraint solver. There is currently no way
to express this in a schema-pop type. The dogfood fixture
(`gpu-physics.1.pop.ts`) explicitly notes this gap.

**Requested shape:** field-level annotation that the WGSL exporter wraps in
`atomic<T>`. Other exporters (Rust/C/TS) likely want to map this to their own
atomic types or ignore with a warning.

```ts
// rough idea:
forces: { type: "u32", atomic: true }
// or
forces: "atomic<u32>"
```

### B2 — Runtime-sized storage arrays

Pajonk's `particles`, `constraints`, `obstacles` are all runtime-sized in WGSL
(`var<storage, read_write> particles: array<Particle>;`). They live in storage
buffers whose length is known only at bind time. Schema-pop currently requires
either `exactLength` or `maxLength`. The exporter falls back to `array<T>`
without bound *only* when neither is set, which gives no way to keep the
length information in the schema-pop type system.

**Requested:** explicit "unbounded storage array" marker, distinct from
"unspecified length". Possibly tied to B5 (storage-buffer binding metadata).

### B3 — JS encoder/decoder target

The biggest pain in pajonk isn't the WGSL — it's the JS side packing values
into Float32Array views with hand-counted offsets:

```ts
// PhysicsState.ts
this.constraints[off + 3] = (color << 16) | cType;
this.constraints[off + 5] = restValue;
this.constraints[off + 6] = compliance;
// ...
```

The WGSL exporter alone replaces 1/3 of the source-of-truth problem. A first-
class **JS/TS binary encoder/decoder target** that reads the same schema and
emits `writeConstraint(view: DataView, off: number, c: Constraint)` /
`readConstraint(view, off): Constraint` would close the loop. Bonus: typed
"struct view" classes that read/write directly into a backing Float32Array
without copying, for hot paths.

The existing `ts` exporter does migration codegen but not binary encoding.

### B4 — `physicsDataBuffer` packing (multiple arrays in one buffer)

Pajonk packs three logically distinct arrays into a single GPU buffer at
fixed byte offsets to stay within the 8–10 storage-binding budget:

```
physicsDataBuffer:
  offset 0       — MPM grid nodes (16384 × 12 B)
  offset 196608  — xpbd_forces atomics (65536 × 4 B)
  offset 458752  — MPM particles (30000 × 80 B)
```

Today these offsets are hand-maintained in three files. **Requested:** a way
to declare a "packed buffer" with named slots and counts, and have schema-pop
emit:

- WGSL: separate `var<storage>` declarations with `@group/@binding` and the
  appropriate offsets baked in.
- JS: an offset-table constant and per-slot views.
- A sanity check that the declared total size matches the sum of slots
  (catches silent misalignment).

This is the highest-leverage feature for replacing pajonk's
`docs/gpu_buffers.md` as a documentation-only contract.

---

## Problem

### P1 — Source field order lost in output

The WGSL exporter iterates `t.fields` in the order the analyzer hands them
back. With `autoLayout: false` + `layoutType: "std430"`, fields come out
**alphabetized**. Example from the dogfood:

```
// schema source (logical grouping):
MpmParticle: { pos, vel, c00, c01, c10, c11, f00, f01, f10, f11, mass, ... }

// emitted output (alphabetical):
struct MpmParticle {
  bulk_modulus, c00, c01, c10, c11, color, f00, f01, f10, f11, gamma, j, mass, ...
};
```

The C/F matrix clusters scatter, semantic adjacency is lost, and the emitted
file becomes much harder to read alongside the schema source. This isn't an
exporter bug — `t.fields` already arrives in alphabetical order.

**Requested:** opt-in `preserveSourceOrder` config that surfaces the original
declaration order alongside any analyzer-driven layout reordering.

### P2 — u8/u16 widening leaves padding inconsistent

WGSL has no 8- or 16-bit integers in host-shareable structs. The exporter
silently widens `u8`/`u16` → `u32`, which is correct for emission, but the
analyzer's `paddingAfter` was computed against the original 1- or 2-byte size.
A schema like `{ tag: u8, val: u32 }` lays out as 1 + 3 pad + 4 = 8 in the
analyzer view; emitted as `tag: u32, _pad_tag: u32, val: u32` it becomes
4 + 4 + 4 = 12.

**Requested:** the WGSL exporter should either (a) recompute layout against
the widened types, (b) reject schemas with sub-32-bit primitives in WGSL
target with a clear error, or (c) emit a warning at generation time pointing
at the field. Whatever the choice, the layout mismatch shouldn't be silent.

### P3 — `vec3` alignment is the std430 booby-trap

In std140/std430, `vec3<f32>` has **size 12 but alignment 16**. The exporter
currently lowers `f32[] == 3` to `vec3<f32>` correctly, but downstream layout
calculations need to know about the 4-byte trailing pad. Worth a test fixture
that catches this; pajonk doesn't use vec3 today (it uses vec2 + vec4
exclusively, partly to avoid this trap), so this is currently academic for us.

### P4 — Cross-target consistency is implicit

If the same `Constraint` schema is emitted to WGSL (with widening) and TS
(without), the byte layouts diverge. There's no central warning that "this
schema produces different byte layouts in different targets". For a *single
source of truth* claim this is the cardinal sin.

**Requested:** at minimum, document this. Better: a "layout digest" hash
comparable across targets, or a strict mode that fails when byte layouts
would diverge.

---

## Nice to have

### N1 — Native matrix types

`mat2x2<f32>`, `mat3x3<f32>`, `mat4x4<f32>`. Pajonk currently hand-flattens
its 2x2 deformation gradient matrices to `c00..c11` — that's 4 fields where
1 should suffice. Cosmetic, not blocking — but adoption-friction.

### N2 — Storage-buffer binding decorators

```wgsl
@group(0) @binding(2) var<storage, read_write> particles: array<Particle>;
```

Today this declaration is hand-written. If the schema can express "this type
is bound at group 0 / binding 2 in shader X", schema-pop could emit the full
binding line.

### N3 — Per-field naming override

Names like `c00`, `c01` are intentional clusters. The current
`fieldNaming: "snake_case"` config is global — there's no way to opt one
field group out of the case transform. Workaround: name fields `c_00`, `c_01`
in the schema. Awkward.

### N4 — WGSL reserved-word detection

A schema field named `ptr`, `let`, `var`, `fn`, etc. would silently produce
broken WGSL. A reserved-word lint at exporter time would catch it.

### N5 — Configurable doc-comment emission

`/// some doc` → `// some doc` above the WGSL field declaration. Description
fields exist on the layout plan today; nothing in the WGSL exporter consumes
them. Easy add, useful for docs alignment.

### N6 — Bitfield slot names

The current bitfield path (`_bitfield_${offset}`) is fine for typical schemas
but the matching `_pad_bits_${f.name}` slot is iteration-dependent and could
emit duplicates if two bitfields land at the same offset with non-zero
`paddingAfter`. Probably never hit in real GPU shader code (WGSL doesn't
support bitfields natively, so the schema would have to come from a
non-WGSL path), but worth noting.

### N7 — `mat3x4` / `mat4x3` etc.

Less common. For completeness with WGSL's full matrix type set.

---

## Local-fix log (already applied)

For reference, the following were addressable inside `wgsl.ts` itself and
have been patched on this branch:

- **`paddingStyle` config** added (`"size" | "fields"`, default `"fields"`).
  Explicit `_pad_<name>: u32` filler fields are more self-documenting than
  `@size(N)` annotations and survive copy-paste between files. Switch to
  `"size"` for the prior compact form.
- **`f64` → throw** with explicit error message (was silently emitting
  invalid `f64` WGSL).
- **Unknown primitive / unsupported field kind → warning** instead of silent
  fallback to `u32`.
- **Baseline test suite** added (`wgsl.test.ts`) covering primitives,
  vectors, fixed-length arrays, alias emission, struct nesting, both
  padding styles, bool widening, and the f64 error path.
