# Schema-Pop Roadmap

## 0.1.35

The 0.1.x line set the core foundation of Schema-Pop:
* **ArkType** constraint-based binary inference.
* Advanced layout strategies (`aligned`, `zero-padding`, `std140`, `std430`).
* Universal Exporter API and multi-language support (Rust, C/C++, Zig, TS, WGSL).
* Bit-packing and tagged unions.
* Test harness scaffolding.
* `INDENT` / `indentBlock` collapsed into a single `indent()` helper.

---

## Current Version 0.2.0

### 1. API Stabilization & Core Engine
* **Stable Plugin API:** Freeze the ExporterPlugin interface to allow the community to build custom exporters reliably.
* **Bitwise Endianness:** Full support for MSB/LSB bit-order definitions in bit-packing.
* **Codec-level migrations** *(landed)*: diff two schema versions, auto-derive the mechanical transform (rename/widen/default/nested), and inject custom logic via `defineMigration` hooks (per-field or whole-type). See [`migrations.md`](./migrations.md).