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

## P3 — `SharedVec::new()` requires `T: Copy + Default` ✅ 0.1.18

`SharedVec::empty()` added to the Rust runtime prelude — uses
`mem::zeroed()` internally with a `len = 0`, so the user never
observes the zero-initialised data. Safe for every type schema-pop
generates (FFI-shaped, repr(C, u8) variant 0 is valid). Unblocks
empty-construction of `SharedVec<Layer, 16>` etc. without the
`Default` bound that `new()` carries.

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

## P4 — Large structs blow up host-stack instantiation ✅ 0.1.18

Every generated struct now has an alloc-gated `boxed_zeroed()`
constructor:

```rust
#[cfg(feature = "alloc")]
impl BindingProfile {
    pub fn boxed_zeroed() -> alloc::boxed::Box<Self> { ... }
}
```

Wraps `alloc::alloc::alloc_zeroed` + `Box::from_raw`. Stack-overflow on
big top-level types becomes a one-call fix.

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

## P11 — Breaking-change migration path between exporter generations ✅ 0.1.18

Two of the three remaining items shipped:

- ✅ `enum.as_str()` — generated for every plain enum and tagged-union
  enum (the latter returns the active variant's tag name). `const fn`
  body, no allocation, no_std-friendly. Wires straight into debug
  logging / telemetry / web UI labels.
- ✅ `derive(Default)` on plain structs — added to the derive list
  when no field's type recurses into an enum / union. `..Default::default()`
  now papers over `_pad_*` fields for the easy case, removing the
  noise from struct literals.

Still open: third-party constructor functions like `T::new(field1, field2)`
that hide padding entirely (alternative to `Default`). Skipped for now
because `Default` covers the most common case and the constructor
form would need per-struct field analysis. Revisit if it bites again.

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

## P15 — PopCodec.decode loses the variant discriminator on tagged unions ✅ 0.1.18

Resolved transitively by P16 fix. The codec already wraps decoded
union payloads as `{ kind: variantName, ...payload }`, but pre-P16
the wrong variant was being selected because of the tag base
off-by-one — once the tag dispatch matches Rust, the schema's
declared `kind` literal field surfaces from the payload bytes (and
overrides the synthesised variantName via spread, so users see the
schema's spelling, e.g. `'taskList'`).

Round-trip locked in by the codec test suite added with P16
(`packages/core/src/codec/pop.test.ts`).

When decoding a `WsMessage` (`#[repr(C, u8)]` enum on Rust side), PopCodec
returns the active variant's payload **without** the `kind` string field
that the schema declares:

```ts
WsTaskList: { kind: "'taskList'", tasks: "..." }
```

Decoded JS object is `{ tasks: [...] }` — no `kind`. The runtime tag byte
isn't surfaced in any form, so consumers can't dispatch on it without
peeking at the raw bytes themselves.

For konektor's GUI / harness this means we can't write:
```ts
switch (msg.kind) { case "taskList": ...; case "systemHealth": ...; }
```

Suggestions (any one):
- Synthesize the `kind` field from the union's tag byte. Look up the
  variant name in the analyzer's plan, emit the schema's `kind` literal.
- Alternatively wrap output as `{ kind: "taskList", value: { tasks: [...] }}`
  so the discriminator is always available.
- At minimum: expose a sibling `decodeTagged(typeName, buffer)` that
  returns `{ tag: number, name: string, value: any }`.

---

## P16 — PopCodec decoded payloads are byte-misaligned vs Rust `#[repr(C)]` ✅ 0.1.15

Fixed in `packages/core/src/codec/pop.ts`. Encoder writes
`variantIndex` (was `variantIndex + 1`); decoder reads
`plan.variants[tag]` (was `plan.variants[tag - 1]`); the implicit
"reserve tag=0 for Unknown" short-circuit is gone. Tag space now
matches what the Rust exporter emits for `#[repr(C, u8)]`. Out-of-range
tags still surface as `UnknownTag(N)` — a corrupt frame won't pretend
to decode as the first variant.

Round-trip verified on a 3-variant fixture: `tagOf("A")=0`,
`tagOf("B")=1`, `tagOf("C")=2`, matching the analyzer's
alphabetically-sorted variant order.

For konektor's repro:  `SystemHealth` is variant index 12 (alphabetical
position in `WsMessage`); codec now writes 12 to byte 0, matching
Rust's `WsMessageTag::SystemHealth = 12`.



🛠 **Diagnostic available — `schema-pop layout`.** 0.1.15 ships a
`schema-pop layout [config-path] [--type T] [--schema S] [--version V]`
subcommand that prints the analyzer's view of every struct / union:
total size, align, per-field offset / size / padding, and the union's
payload offset. Paste it next to a Rust `core::mem::offset_of!`
printout to find the divergence in one shot.

### ✅ Root cause confirmed (2026-05-02): tag base off-by-one between codec and Rust generator

Ran the diagnostic on konektor's real `WsMessage`. Result:

| | analyzer (`schema-pop layout`) | Rust (`core::mem::offset_of!`) | match |
|---|---|---|---|
| `WsMessage` total size | 412 | 412 | ✅ |
| `WsMessage` align | 4 | 4 | ✅ |
| `SharedString<32>` size | 36 | 36 | ✅ |
| `SystemHealth` field order | alphabetical | alphabetical | ✅ |
| `SystemHealth.boot_slot` offset | 4 (=4 + 0 within payload) | 0 | ✅ |
| `SystemHealth.heap_free` offset | 40 | 36 | ✅ |
| every other field | matches | matches | ✅ |

**Layout is byte-perfect.** The bug is in **tag dispatch**, not layout.

Repro: encode SystemHealth in TS via `codec.encode("WsMessage", {...})`
and inspect byte 0. Result: `0x0d` (= 13). Then encode via Rust
(`&WsMessage::SystemHealth(...) as *const u8`). Result: `0x0c` (= 12).
Same data, same field order, **different tag byte** — Rust 12 / TS 13.

Source of the divergence:

```ts
// schema-pop/packages/core/src/codec/pop.ts
83:   view.setUint8(baseOffset + plan.tagOffset, variantIndex + 1);
//                                                              ^^^ +1
120:  const tag = view.getUint8(baseOffset + plan.tagOffset);
121:  if (tag === 0) return "Unknown";
122:  const variant = plan.variants[tag - 1];
//                                       ^^^ -1
```

PopCodec **reserves `tag = 0` for "Unknown"** and emits / consumes
`variantIndex + 1`. The Rust exporter emits the tag enum starting at 0
without that reservation:

```rust
// generated:
pub enum WsMessageTag {
    BleAuthRequest = 0,    // ← starts at 0, no Unknown reserved
    BleBindings = 1,
    ...
    PeripheralList = 11,
    SystemHealth = 12,     // ← codec writes 13 for this variant
    TaskList = 13,
    ...
}
```

So when firmware broadcasts a SystemHealth (Rust writes tag = 12),
PopCodec reads `tag = 12`, computes `plan.variants[12 - 1] = plan.variants[11]`,
and decodes the payload through the **PeripheralList** struct layout.
That's why konektor's GUI saw "version=nvs_writer" / "role=io_out_p0":
the `attached: AttachedDevice[]<=4` field of PeripheralList laid over
the SystemHealth bytes happens to interpret `boot_slot.len + first
chars of "BOOT"` as a couple of `pid`/`vid` u16s — pure coincidence
that it parses without error.

### Fix options (pick one and align both sides)

1. **Codec drops the +1.** `setUint8(..., variantIndex)` /
   `plan.variants[tag]`. No "Unknown" sentinel. Cleanest, but anyone
   who had `if (tag === 0)` semantics breaks.
2. **Rust generator adds `Unknown = 0` and shifts all variants by 1.**
   `BleAuthRequest = 1`, ..., `SystemHealth = 13`, etc. Matches current
   codec. The `Unknown = 0` arm is also handy for forward-compat
   (decoder sees a tag from a newer schema, falls into Unknown).
   This also implies the same change for the C/C++ exporters.
3. **Plan stores explicit tag value per variant** (`{ name, tag }` not
   just an array index), and both codec and Rust/C exporters read from
   it. Most robust, decouples wire-format tag values from declaration
   order so future variant reordering doesn't shift the wire format.

**Recommendation:** option (2) — keeps the Unknown forward-compat
sentinel that's already in the codec, just propagates the same
convention into the generators. Option (3) is nicer but bigger.

For konektor we're going to apply (2) locally as a sed (add
`Unknown = 0` to the head of each `*Tag` enum, increment all variant
discriminants by 1, plus a matching `WsMessage::Unknown` arm whose
payload is `()` or `[u8; max_payload_size]`) — but this is fragile
without upstream support.

Original report below for context:


Distinct from P15. Even when PopCodec picks (apparently) the right variant,
the decoded field values are scrambled — strongly suggesting the analyzer's
field layout doesn't match what the Rust `#[repr(C)]` emitter generates.

### Concrete repro

Firmware (Rust, layer 1) builds and broadcasts a `WsMessage::SystemHealth(...)`
every second:

```rust
let health = SystemHealth {
    uptime_secs: 2932,
    heap_free: ~200_000,
    heap_free_internal: ~150_000,
    nvm_free: ~24_000,
    nvm_total: 24576,
    ws_dropped: 0,
    version: "0.0.728".into(),
    role: "Master".into(),
    reset_reason: 0,
    boot_slot: "".into(),
};
registry.broadcast(&WsMessage::SystemHealth(health));
```

`SystemHealth` is `#[repr(C)]` (or part of `#[repr(C, u8)]` enum
`WsMessage`) with fields exactly as schema-pop generated. Wire encoding
is just `&raw const health as *const u8` for `sizeof(WsMessage)` bytes.

GUI (TS) decodes via `codec.decode("WsMessage", arrayBuffer)`. The decoded
JS object is:

```js
{
  uptime_secs: 2932,                    // ✅ correct
  heap_free: 1_700_754_546,             // ❌ garbage (real value ~200k)
  heap_free_internal: 1_852_401_518,    // ❌ garbage
  nvm_free: 101,                        // ❌ garbage
  nvm_total: 0,                         // ❌ should be 24576
  ws_dropped: 121,                      // ❌ should be 0
  version: "nvs_writer",                // ❌ should be "0.0.728" — this is a FreeRTOS task name string from a different message!
  role: "io_out_p0",                    // ❌ should be "Master" — also a task name
  reset_reason: 1596,                   // ❌ should be 0
  boot_slot: "  ", // ❌ should be ""
}
```

`uptime_secs` — the very first field — is the only one that decodes
correctly. Everything after it is shifted/wrong.

### What "version=nvs_writer" tells us

`"nvs_writer"` and `"io_out_p0"` are **FreeRTOS task names** that only
appear inside `WsMessage::TaskList { tasks: Vec<TaskStatus { name, heap_free }> }`.
That message is broadcast on the same WS connection, immediately after the
`SystemHealth`. So one of two things:

1. **Wrong variant detection.** PopCodec read the leading tag byte, picked
   the wrong arm of `WsMessage`, and parsed `TaskList` bytes through the
   `SystemHealth` field layout. Result: task-name strings appear in
   `version`/`role` positions.
2. **Stale buffer reuse.** Decoder reused a buffer from a previous frame
   (TaskList) and overlaid SystemHealth fields onto it without zeroing.

Either way, **schemes that work in isolation break under multi-variant
traffic on the same channel**, which is the normal case.

### Layout assumptions that may be diverging

- `WsMessage` is `#[repr(C, u8)]` on Rust → 1-byte tag at offset 0,
  followed by the largest variant payload, padded to total `sizeof`.
- The Rust generator emits each variant as its own `#[repr(C)]` struct
  inside the union. Fields are laid out in declaration order with natural
  alignment.
- PopCodec's analyzer needs to apply the **same** alignment rules to
  reach the same offsets. If the analyzer thinks `SharedString<32>` is
  N bytes but Rust thinks it's M bytes (e.g. different len-prefix size,
  different padding around the inner array), every subsequent field
  shifts.

In our case `SharedString<N>` is generated as something like
`{ len: u32, data: [u8; N] }` or `{ len: u32, data: [u8; N], _pad: [u8; P] }`
to satisfy alignment of the next field. If TS analyzer computes a different
`P` than Rust does, all later fields slide.

### Suggestions

- **Cross-validation test in schema-pop CI.** For each multi-variant union
  in a fixture schema: encode in Rust (`as_bytes`), decode in TS
  (`PopCodec.decode`), assert deep-equal. This would have caught this
  immediately. Same in reverse (TS encode → Rust decode). Conceptually
  the same as a fuzz test but with hand-picked representative inputs.
- **Layout dump tool.** A `pop-layout WsMessage` CLI command that prints
  exactly what PopCodec thinks each field's offset and size is. Then a
  Rust-side `layout::<WsMessage>()` helper that prints the equivalent
  from `core::mem::offset_of!` and `core::mem::size_of`. Diff the two
  to find the misalignment instantly.
- **Document the "no padding holes" assumption**, if there is one. If
  the TS analyzer assumes the Rust compiler will pack a certain way and
  that ever diverges (e.g. `repr(C)` on different targets, or with
  `align(N)` modifiers), document the contract.
- **Variant-tag dispatch must match.** P15 already noted PopCodec drops
  the `kind` field; the deeper issue here is whether PopCodec is even
  reading the tag byte from the correct offset. If `WsMessage` total
  size is 448 B and the tag is at offset 0, decoding `decode("WsMessage", buf)`
  needs to read `buf[0]`, look up the variant, and parse from offset 1
  (or wherever the variant payload starts after alignment padding).
  Verify this is what's happening.

This is the highest-impact one for konektor right now: until decoded
payloads match what the firmware sends, the e2e test harness can't
assert anything meaningful.

---

## P17 — Distinct `T[]<=N` schema entries collapse to the same Rust type ✅ 0.1.15

Fixed in analyzer: when looking up a field's type, we now consult the
user-typed source string in `scope.aliases[parent][field]`. A pure
identifier (`"MacAddress"`) resolves to a ref; anything compound
(`"u8[]<=6"`, `"A | B"`, `"{ x: u8 }"`) skips strict-identity matching
at the top level so arktype's structural-dedupe doesn't silently
collapse the field onto a same-shape alias. Inline branches inside
unions still resolve to refs because recursive calls leave the gate
off.

Result for the original repro: `KeyboardData.keys` emits as
`SharedVec<u8, 6>` (inline), `MacAddress` stays a distinct top-level
type, and `Pkt { mac: "MacAddress" }` keeps its named ref.

Original report below for context:


Two unrelated schema entries with structurally-identical bodies share a
generated type. Schema:

```ts
MacAddress: "u8[]<=6",
KeyboardData: { keys: "u8[]<=6", modifiers: "u8" },
```

Generated Rust:

```rust
pub struct MacAddress { pub _bytes: [u8; 12] }
// ...
pub struct KeyboardData {
    pub keys: MacAddress,            // ← reused alias
    pub modifiers: u8,
    pub _pad_modifiers: [u8; 3],
}
```

Wire layout is unaffected (both are 6 bytes + length prefix), but
**semantically** `KeyboardData.keys: MacAddress` is wrong — keys are
keyboard usage codes, not a MAC. Caller code sees the wrong type
annotation, and any helper methods or trait impls scoped to `MacAddress`
("nice to have: `.octets()`, `.to_hex_string()`") leak onto unrelated
fields.

The collision is structural: any two `T[]<=N` with the same `T` and `N`
get unified. Inline-defined `u8[]<=6` field (no top-level alias) doesn't
trigger this; the moment a top-level entry exists the collision starts.

Suggestions:
- Don't unify field types with top-level aliases unless the field's
  schema entry literally references the alias by name. Treat
  `keys: "u8[]<=6"` (inline) as anonymous, distinct from
  `keys: "MacAddress"` (named reference).
- Or: document this so consumers know to inline `u8[]<=6` everywhere
  except the one place they want the alias.
- Or: emit each occurrence as its own newtype (`pub struct
  KeyboardKeys(pub [u8; 6+padding]);`) so type identity matches field
  identity.

Workaround for konektor: change one of the two bounds (`u8[]<=8` for
keys?) — but that ripples into wire-format size choices. Not a clean fix.

---

## P14 — Generator crashes on `'A' | 'B' | 'C'` lifted to top-level type alias ✅ (not a bug)

Root cause was version skew between sibling packages, not a generator
bug. Already addressed by the 0.1.14 split (workspace deps pinned to
the same version on every release). Documented for posterity.

Adding a top-level inline string union as a schema entry:

```ts
InjectInputKind: "'Key' | 'Axis' | 'Relative'",
WsInjectInput: { kind: "'injectInput'", input_kind: "InjectInputKind", ... }
```

…produces `TypeError: indent is not a function` from
`packages/core-exporters/src/rust.ts:294`. Root cause turned out to be that
**`@schema-pop/core-exporters` declares `"schema-pop": "0.1.13"`** (the npm
version) instead of a workspace dep. So local overrides on `schema-pop`
don't propagate to its sibling — core-exporters loads the OLD published
core, where `ExporterTools` had no `indent` member.

Two suggestions:
- Switch `core-exporters/package.json` (and `extra-exporters`) to
  `"schema-pop": "workspace:*"` so a local schema-pop change is always
  paired with the matching exporters.
- For konektor we worked around with a top-level `overrides` entry in our
  root `package.json`:
  ```json
  "overrides": {
      "schema-pop": "file:../schema-pop/packages/core",
      "@schema-pop/core-exporters": "file:../schema-pop/packages/core-exporters",
      "@schema-pop/extra-exporters": "file:../schema-pop/packages/extra-exporters"
  }
  ```
  Worth documenting this pattern for anyone consuming local schema-pop.

The actual `indent is not a function` error was therefore version skew, not
a generator bug — but the error message is opaque (no hint that it's a
loaded-version issue). Worth a pre-flight check in `core-exporters` that
the `ExporterTools` it imported has the methods it expects.

---

## P13 — `versionNamespace: false` only honored by Rust exporter ✅ 0.1.18

C exporter now mirrors the Rust signature: `versionNamespace: false`
drops the prefix entirely, `string` overrides it. CPP exporter still
wraps via `namespace { ... }` (different mechanism — the C-style
prefix isn't there to begin with).

```c
// versionNamespace: false →
typedef uint8_t BleMode;
#define BLE_MODE_OFF ((BleMode)1)

// versionNamespace: "ws" →
typedef uint8_t ws_BleMode;
#define WS_BLE_MODE_OFF ((ws_BleMode)1)
```

`rust({ versionNamespace: false })` (P2 fix) skips the `pub mod konektor_1_0`
wrap. The C exporter however still prefixes every symbol with the version
identifier:

```c
typedef uint8_t konektor_1_0_BleMode;
#define KONEKTOR_1_0_BLE_MODE_OFF ((konektor_1_0_BleMode)1)
```

So C consumers still need to write `konektor_1_0_BleMode_Off` instead of
the natural `BleMode_Off`. Suggestion: honor the same `versionNamespace`
config option in `c()` and `cpp()`. When false, drop the `konektor_1_0_`
prefix from typedef names and `KONEKTOR_1_0_` prefix from `#define`s.

For konektor we sed-rewrote ~30 C call sites instead of waiting; not a
huge deal but every new exporter target re-introduces the same friction.

---

## P12 — More integration findings (round 2 with 0.1.13 / 0.1.14 features)

After regenerating with `versionNamespace: false` + the new real-enum
generation, a fresh wave of issues:

- **`MacAddress` becomes opaque `pub struct MacAddress { pub _bytes: [u8; 12] }`**
  even though the schema declares `MacAddress: "u8[]<=6"`. Consumers (whose
  code reads `mac.as_slice()` or constructs from `Vec<u8>` / `[u8; 6]`)
  break. Suggestion: emit type aliases for `T[]<=N` schemas as
  `pub type MacAddress = SharedVec<u8, 6>;` so callers get `as_slice` /
  `From<[u8; 6]>` automatically. The `_bytes: [u8; 12]` isn't useful —
  it's a magic 12 (= 4-byte length + 6-byte data + 2 padding) that the
  caller has no way to interpret.

- **Inline-string-union field types get auto-named**: `WsCommand.command:
  'ClearBleScan' | ...` becomes `WsCommandCommand` (parent + field name
  PascalCased). Consumers using the old generation's `Command` name break.
  Sed-able but worth documenting the naming convention.

- **`HidDeviceType` has no fallback variant** — the schema declares only
  Gamepad/Keyboard/Mouse, but downstream code wants an `Unknown`/`None`
  for "device type not yet detected" cases. Today users either add an
  explicit "Unknown" variant to the schema (verbose) or wrap in
  `Option<HidDeviceType>` (idiomatic). Maybe a `#[default]` annotation
  in the schema (`HidDeviceType: "'Gamepad' | 'Keyboard' | 'Mouse'", with
  `defaultVariant: "..."` somehow) would let `derive(Default)` work.

- **`as_str()` confirmed missing** for both plain enums and tagged-union
  enums. Already in P11; reiterating because it shows up in many places
  (debug logging, telemetry serialization, web UI labels). Concrete
  proposal: `pub fn as_str(&self) -> &'static str` returning the schema
  variant name string. For tagged unions, return the tag's name.

- **`_pad_*` fields still need explicit specification** in struct
  literals: `KeyboardData { modifiers, keys, _pad_modifiers: [0; 1] }`.
  When the only padding is for alignment (zero-init is always correct),
  this is pure noise. Either: (a) generate `Default` for plain structs so
  `..Default::default()` covers padding, or (b) generate constructor
  functions like `KeyboardData::new(modifiers, keys)` that hide padding.

- **Workspace dep to local schema-pop via `file:` works** but hits Bun
  registry caching: `bun add schema-pop@latest` happily resolves to
  whatever's in `~/.bun/install/global` cache. Had to use
  `file:../../../schema-pop/packages/core` to escape the cache. Worth a
  note in scaffold docs that local development requires file: deps.

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
