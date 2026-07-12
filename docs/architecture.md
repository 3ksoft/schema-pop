# Architecture overview

`schema-pop` is a schema-first development framework using TypeScript as the **single source of truth** for cross-language binary data synchronization. The pipeline is intentionally small and stateless.

## Core components

1. **Schema definition (ArkType)** — high-level data modeling using standard TypeScript syntax. Constraints (numeric ranges, string literals, generics like `Binary<>` / `Bit<>` / `Obsolete<>`) describe both the logical type and binary metadata.
2. **Schema analyzer** — a deterministic engine that translates logical types into a physical memory map. Picks the smallest fitting primitive for unconstrained `number`, infers `u8`–`u64` and bit-packed `u1`–`u7` from constraints, computes alignment and padding per layout strategy.
3. **Linear Layout Plan (LLP)** — the intermediate representation. Contains exact byte and bit offsets, alignment, padding, tag offsets for unions, and metadata propagated from the schema (descriptions, deprecation flags). Exporters consume only the LLP.
4. **Exporters** — stateless plugin functions that turn an LLP into source code or other artifacts. Built-ins cover Rust (+ serde) / C / C++ / Zig / TypeScript (interfaces, binary codec, exports) / Markdown / WGSL / HTML / SVG / Mermaid / random fixtures / Brainfuck, plus WebGPU binding harnesses. Each exporter is ~100–300 LoC; you can write your own ([guide](./exporters/writing_own_exporters.md)).
5. **PopCodec** — a zero-dependency TypeScript runtime that uses an embedded LLP to read/write binary buffers from JS without code generation.

## Pipeline

```
schema.ts (ArkType scope + markers)
        │  fromModule(mod.export())
        ▼
   ExtractionContext ──▶ SchemaAnalyzer().analyze(ctx, settings)
                              │
                              ▼
                         LayoutPlan ──▶ exporter₁ ─▶ artifact₁
                                  ├────▶ exporter₂ ─▶ artifact₂
                                  └────▶ exporter_N ─▶ artifact_N
```

The pipeline is driven imperatively from a small build script: `fromModule` extracts a schema from an ArkType module into an `ExtractionContext`, `SchemaAnalyzer().analyze(ctx, settings)` returns `{ plan, warnings, errors }`, and each exporter turns `plan` into an artifact — either `exportPlan(plan, target, config)` or the exporter factory directly (`ts({...}).generate(plan)`). The `schema-pop` CLI wraps the same pipeline for a single file (flags `-t` target, `-o` output, `-m` mode). There is no config file, no version registry, no Vite plugin, and no compilation phase beyond generating files.

## Data flow at runtime

- **Native**: binary data ↔ native struct via zero-copy pointer cast / `memcpy` into a `#[repr(C)]` or `extern struct`.
- **Web**: binary data ↔ `PopCodec` ↔ ArkType validation ↔ application logic.
- **Cross-language**: the ABI consistency test in `--type all` scaffolds verifies that the same bytes round-trip identically through every native harness.

## Design philosophy

Unlike Protobuf or Flatbuffers, `schema-pop` produces **human-readable native code** that feels hand-written in the target language, while strictly maintaining ABI compatibility via centralized layout calculations.

There is no "schema runtime" in the generated artifacts — just plain structs, plain enums, plain unions. You can vendor the output, modify it, or strip out targets you don't need; the code keeps working.
