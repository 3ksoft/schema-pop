# Requests / observations from konektor integration

Running list of pain points and feature requests surfaced while integrating
schema-pop into the konektor firmware (no_std Xtensa Rust + std host Rust +
Vue/TS GUI). Roughly priority-ordered.

---

## P1 — Wire format strategy needs documentation + alternative

PopCodec emits **fixed memory-layout** encoding: every `WsMessage` instance
takes `sizeof(WsMessage) = 448 B` regardless of which variant is active.
Konektor's WS telemetry stream sends e.g. a 6-byte `HardwareStatus` payload
that becomes 448 B on the wire — **75× overhead** for the small variants.

Options to consider:

- A "compact" encoding mode alongside fixed-layout. Borsh-style: 1-byte tag
  + variant payload only. Same generated types, two codec impls.
- At minimum: document size implications loudly in the binary protocol doc.
  Right now it's not obvious that `decode("WsMessage", bytes)` will reject
  a 60 B frame as "Buffer too small for WsMessage. Expected at least 448 B".
- Or: support per-frame "active variant byte size" so the codec can decode
  truncated buffers when only the active variant's prefix is present.

For high-frequency telemetry on resource-constrained links, fixed-size is a
real cost. Konektor will have to choose between schema-pop binary and
something compact, and right now the choice is binary (lose 7×) or hand-roll.

---

## P2 — Versioned namespace wrap forces consumer indirection ✅ 0.1.14

`rust({ versionNamespace: false })` skips the wrap; `versionNamespace: "ws"`
renames it. Single-version files can drop the indirection entirely.

---

## P3 — `SharedVec::new()` requires `T: Copy + Default`

Generated complex types (`Layer`, `Macro`, `Binding`, etc.) don't `derive(Default)`
because their unions/enums can't have a meaningful default. Result:

```rust
SharedVec::<Layer, 16>::new()  // ERROR: Layer doesn't impl Default
```

Test code can't construct empty `SharedVec` of generated types. Workaround:
zero-init via `unsafe { mem::zeroed() }` and direct struct construction.
Works because all generated types are valid as zero bytes (enum tag 0 is a
valid variant), but it's a footgun.

Options:
- `SharedVec::empty()` constructor without `Default` bound (uses
  `MaybeUninit<[T; N]>` internally, `len = 0`).
- `derive(Default)` on generated structs whose enums have a `#[default]`
  variant (or pick variant 0 by convention).

---

## P4 — Large structs blow up host-stack instantiation

`BindingProfile` lays out to ~400 KB. Constructing on the stack in test
helpers (`let p = profile(...);`) overflows the default thread stack and
the test process aborts with SIGABRT.

Workaround: heap-allocate via `alloc::alloc_zeroed` + `Box::from_raw` and
fill fields in place. Documented in our test helpers but ugly.

Request: generated runtime helper for big top-level types, e.g.

```rust
impl BindingProfile {
    pub fn boxed_zeroed() -> Box<Self> { /* alloc_zeroed + from_raw */ }
}
```

Gated on `alloc` feature so it stays no_std-compatible.

---

## P5 — `From<String>` / `From<Vec<T>>` not generated for SharedString/SharedVec ✅ 0.1.14

Emitted: `From<&[T]>` (always on), plus alloc-gated `From<String>`,
`From<&String>`, `From<Vec<T>>`. Crates using these add `alloc = []` to
their feature list.

---

## P6 — Top-level scope export name conventions ✅ 0.1.14

Builder now duck-types any named export as a fallback after `$` and the
schema name. `export const konektor = scope({...})` works without any
`exportName` config.

---

## P7 — Enum types use `pub type X = u8` + consts, lose type safety ✅ 0.1.14

Plain enums now emit as `#[repr(uN)] #[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum X { ... }`. Wire format unchanged. **Breaking** for callers using
the old `MACRO_LOOP_MODE_*` consts — see P11 for migration notes.

---

## P8 — `c` exporter regressions to watch for

Earlier in this integration we hit:
- Identifiers with dots (`default_1.0_*`)
- `undefined` for var-len array fields
- Missing enum/union declarations
- Forward-reference ordering (struct A used before declared)

All fixed upstream by the time we needed them. Worth a dedicated regression
test (`cargo test -p schema-pop --test c_exporter` or similar) so they don't
silently come back. The C output is the path firmware C code reads, so any
regression breaks downstream compilation.

---

## P9 — Document the trust model around enum discriminants

Generated `#[repr(C, u8)] enum Action { ... }` — reading raw bytes into
`&Action` is UB if the discriminant byte is out of range. Konektor's
`validate_profile` walks structure but explicitly does NOT check enum
discriminants (would require byte-level parallel walk of the layout).

Suggestion: include a "trust boundary" section in `docs/binary-protocol.md`
explaining:
- Profiles must come from a trusted producer (schema-pop encoder)
- Validation responsibilities of the consumer
- Optional: a generated `validate_bytes(buf) -> bool` helper that checks
  every discriminant byte against valid variant tags

---

## P10 — TS exporter shape vs ArkType runtime types

GUI uses `konektor.export()` from ArkType to get runtime validators
(`WsMessage.assert(...)`). The schema-pop `ts` exporter generates static
`interface` definitions which are useful but don't replace the ArkType
runtime types — so GUI keeps both: ArkType source for runtime + PopCodec for
binary decoding.

That's fine, but worth documenting that the `ts` exporter is for type-level
consumption only, not a drop-in replacement for ArkType.

---

## P11 — Breaking-change migration path between exporter generations

Status update for 0.1.14:
- ✅ `EnumName::Variant` access — restored by P7 (real enum emission).
- ✅ `From<String>` / `From<Vec<T>>` / `From<&[T]>` — emitted by P5.
- ❌ `enum_val.as_str()` impl — still missing. Cheap to add (match arm
  per variant in a generated `impl EnumName`). Worth doing.
- ❌ `_pad_*` fields in struct literals — still required. Constructors
  like `T::new()` or `T { /* fields */ ..Default::default() }` would
  paper over this. `derive(Default)` on plain structs is the right
  mechanism (P3 also touches this).
- ❌ Variant-to-string lookup on tagged-union enums — same as as_str.

Remaining suggestions:
- Generate `impl EnumName { pub fn as_str(&self) -> &'static str }` for
  every enum (plain + tagged-union tag).
- `derive(Default)` on plain structs (no enums in fields). Reduces the
  struct-literal padding footgun for the easy cases.
- A migration script that does the obvious sed transforms would save hours.

---

## Notes on what works well

For balance — these are wins to keep:

- `#[repr(C, align(N))]` deterministic layout across Rust/C++/TS — solid foundation
- Inline `SharedString<N>` / `SharedVec<T, N>` (no separate runtime crate) — clean
- `#[repr(C, u8)] enum` for tagged unions — natural Rust pattern matching
- `bool: "u8"` primitive mapping — explicit comment about UB risk in `rust.ts` is excellent
- HTML + Mermaid output for layout visualization — invaluable when designing the schema
- Boundedness via `T[]<=N` and `string<=N` — natural for embedded
- Sub-byte primitives (`0 <= n < 4` → u2) — clever, useful

The integration is overall going well. These are sharpening notes, not
blockers.
