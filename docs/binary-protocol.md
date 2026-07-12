# Binary protocol

`schema-pop` produces standard C-ABI-compatible binary layouts. The protocol is not a custom wire format — it's whatever your target language naturally produces for `#[repr(C)]` / `struct alignas(N)` / `extern struct`.

## Memory layout

- **Endianness**: configurable per build (`endian: "le" | "be"` in the analyzer settings). Default little-endian.
- **Alignment**: each primitive is naturally aligned (a 4-byte type starts at offsets divisible by 4).
- **Padding**: explicit padding bytes (`_pad_*`) are emitted by every exporter to maintain alignment across compilers. The analyzer pre-computes them; exporters render them.

## Primitives

| Type                  | Size (bytes) | Alignment    |
| --------------------- | ------------ | ------------ |
| `u8`, `i8`, `bool`    | 1            | 1            |
| `u16`, `i16`          | 2            | 2            |
| `u32`, `i32`, `f32`   | 4            | 4            |
| `u64`, `i64`, `f64`   | 8            | 8            |
| `u128`, `i128`        | 16           | 8            |
| `u1`–`u7` (bit-packed)| <1           | (in parent)  |

Bit-packed primitives (`u1`–`u7`) are aggregated into byte-sized containers when `autoPack` is on; the analyzer manages the bit offsets.

## Composite types

### Struct

Standard C ABI: alignment is the maximum of any field's alignment, total size is rounded up to that alignment. Each field has explicit `paddingAfter` to keep the next field aligned.

### Enum

Backed by an unsigned integer (`u8` / `u16` / `i32` depending on variant count). Variants compile to constants in the target language.

### Tagged union

Stored as `[tag, padding, payload]`:

- `tag` of type `tagType` (`u8` / `u16` / `u32`) at offset 0
- payload starts at the alignment of the largest variant
- total size is `tagOffset + tagSize + max(variant_size)` rounded up to the union's alignment

For ABI safety in target languages, the union compiles to an opaque struct holding a fixed-size byte array (`[u8; paddedSize]`) and explicit alignment. The TypeScript codec discriminates variants at runtime.

### Alias

Layout is identical to the underlying type. Native targets emit it as an opaque byte struct of the right size for ABI predictability.

## Layout strategies

The analyzer supports four layout modes (configurable via `layout` in the analyzer settings):

| Strategy       | Use case                  | Notes                                                  |
| -------------- | ------------------------- | ------------------------------------------------------ |
| `aligned`      | C / C++ / Rust ABI        | Default. Natural alignment, padded to type boundary.   |
| `zero-padding` | Network protocols, IoT    | Equivalent to `__attribute__((packed))`. Alignment 1.  |
| `std140`       | GPU uniform buffers (UBO) | OpenGL/Vulkan UBO rules; arrays stride to 16 bytes.    |
| `std430`       | GPU storage buffers       | Like `std140` minus the 16-byte array rounding.        |

See [`analyzer/layouts.md`](./analyzer/layouts.md) for the full rules.

## Trust boundary

`schema-pop`'s binary tier is a **memory-layout contract**, not a
validating wire format. Decoding is a `*const T → &T` reinterpretation
in native targets, and a typed-array read in the TypeScript codec.
Neither pass validates field values — that's the producer's job.

### Producer responsibilities

A producer is **trusted** when it writes bytes through generated
schema-pop types (`PopCodec.encode`, Rust `as_bytes(&val)`, etc.). The
contract:

- Every `#[repr(C, u8)]` enum byte is a real variant — never construct
  `WsMessage` from arbitrary memory; always go through a constructor
  or `PopCodec`. Reading bytes into `&Action` whose tag is
  out-of-range is **undefined behaviour** in Rust.
- Every `SharedString<N>` / `SharedVec<T, N>` length prefix is `≤ N`.
  The codec clamps; the Rust runtime trusts.
- Every `_pad_*` byte is zero. Generated `Default` (P11) and
  `boxed_zeroed()` (P4) handle this; manual struct literals must not
  leak stack noise into padding (use `..Default::default()`).

### Consumer responsibilities

When bytes come from the **outside** (network, file, IPC from an
untrusted peer), the consumer is responsible for:

1. **Discriminant validation** — for every `#[repr(C, u8)]` enum in
   the schema, check the tag byte is in range before reinterpreting.
   `schema-pop`'s `as_str()` impl on enums (P11) returns
   `"UnknownTag(N)"` for out-of-range tags via the `PopCodec`
   read path; raw casts skip this check.
2. **Length-prefix validation** — `SharedString<N>` / `SharedVec<T, N>`
   length must be `≤ N`. PopCodec clamps; Rust raw access doesn't.
3. **Layout pinning** — bytes only round-trip when both sides use the
   same `schema-pop` version + the same analyzer settings
   (`wordSize`, `layout`, `autoSort`, `autoPack`). Dump the analyzer's
   `LayoutPlan` and pair with `core::mem::offset_of!` on the producer
   side to lock alignment.

### Inspecting the layout

The analyzer's `LayoutPlan` (`SchemaAnalyzer.analyze(...).plan`) holds
the exact field offsets / sizes it computed and is plain JSON — dump it
and diff against `core::mem::offset_of!` output to find drift across
language boundaries.

- Generated `Type::as_str()` — schema variant name, useful for
  debug-logging unrecognised tags.

### What schema-pop deliberately does not do

- **No on-the-wire validation.** A decoder reads what's there; no
  checksums, no per-field bounds re-check, no schema-version probing.
  Wrap in your own framing if you need one.
- **No runtime type-checking on the codec output.** PopCodec returns
  whatever the bytes say. Combine with arktype's runtime validators
  on the TypeScript side if you need shape checks (see TS exporter
  notes in [`schema-exporters.md`](./exporters/schema-exporters.md)).



The `--type all` scaffold ships a TypeScript driver that:

1. encodes randomized fixtures via `PopCodec`,
2. spawns each native harness (`harness roundtrip <version> <type>` over stdin/stdout),
3. asserts the returned bytes match the input byte-for-byte.

If the layout drifts in any target, the test fails immediately — your CI catches it on the next save.
