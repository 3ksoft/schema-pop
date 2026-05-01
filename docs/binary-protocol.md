# Binary protocol

`schema-pop` produces standard C-ABI-compatible binary layouts. The protocol is not a custom wire format — it's whatever your target language naturally produces for `#[repr(C)]` / `struct alignas(N)` / `extern struct`.

## Memory layout

- **Endianness**: configurable per build (`endian: "le" | "be"` in `pop.config.ts`). Default little-endian.
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

Bit-packed primitives (`u1`–`u7`) are aggregated into byte-sized containers when `autoLayout` is on; the analyzer manages the bit offsets.

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

The analyzer supports four layout modes (configurable via `layout` in `pop.config.ts`):

| Strategy       | Use case                  | Notes                                                  |
| -------------- | ------------------------- | ------------------------------------------------------ |
| `aligned`      | C / C++ / Rust ABI        | Default. Natural alignment, padded to type boundary.   |
| `zero-padding` | Network protocols, IoT    | Equivalent to `__attribute__((packed))`. Alignment 1.  |
| `std140`       | GPU uniform buffers (UBO) | OpenGL/Vulkan UBO rules; arrays stride to 16 bytes.    |
| `std430`       | GPU storage buffers       | Like `std140` minus the 16-byte array rounding.        |

See [`analyzer/layouts.md`](./analyzer/layouts.md) for the full rules.

## Cross-language verification

The `--type all` scaffold ships a TypeScript driver that:

1. encodes randomized fixtures via `PopCodec`,
2. spawns each native harness (`harness roundtrip <version> <type>` over stdin/stdout),
3. asserts the returned bytes match the input byte-for-byte.

If the layout drifts in any target, the test fails immediately — your CI catches it on the next save.
