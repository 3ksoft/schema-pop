# Schema-Pop Roadmap

## Current Version: 0.1.0

With version 0.1.0, the core foundation of Schema-Pop is set:
* **ArkType** constraint-based binary inference.
* Advanced layout strategies (`aligned`, `zero-padding`, `std140`, `std430`).
* Universal Exporter API and multi-language support (Rust, C/C++, Zig, TS, WGSL, GLSL).
* Bit-packing and tagged unions.
* Auto-generated cross-language migrations.
* Test harness scaffolding.

---

## 🎯 Version 0.2.0 Goals

The next major milestone focuses on stabilization and internal schemas finalization.

### 1. API Stabilization & Core Engine
* **Stable Plugin API:** Freeze the ExporterPlugin interface to allow the community to build custom exporters reliably.
* **Bitwise Endianness:** Full support for MSB/LSB bit-order definitions in bit-packing.
* **Custom Migration Hooks:** Allow developers to inject custom transformation logic into the auto-generated migration functions.

### 2. More core languages
* Go, CPython, whatever is fancy ...

### 3. Test suite improvement
* Add more test schemas
* Add benchmarks
* Unit tests coverage for analyzer

## 0.2.0 and beyond

After 0.2.0 schema-pop will strictly adhere to semantic versioning. 
Here's some loose ideas we might pursue in no particular order.

* **Schema Registry:** Ability to publish, version, and fetch binary schemas remotely.
* **PGlite & PostgreSQL:** Direct mapping of schemas to SQL tables and JSONB columns, with automatic DB migrations.
* **Embedded NVS (Non-Volatile Storage):** Exporters for ESP32/Zephyr NVS with built-in version patching for OTA updates.
* **Browser IndexedDB:** Seamless persistence layer for web apps using `PopCodec`.
* **Zero-Copy RPC:** Generate client/server RPC boilerplate (TypeScript frontend + Rust/Zig backend) using Schema-Pop as the transport layer.
* **WebSocket / WebRTC Data Channels:** Out-of-the-box wrappers for high-frequency, low-latency binary streaming (e.g., game state, IoT telemetry).
* **VS Code Extension:** Hover over ArkType schemas to instantly visualize memory offsets, padding, and binary sizes.
* **Live Memory Dashboard:** A local dev-server UI showing interactive visual maps of the structs and memory utilization.
* **Fuzzing & Validation:** Auto-generate fuzzing test harnesses for Rust/C++ based on the ArkType boundaries.
* **Binary Validators** Pre-compiled validators for specific schema.
* **schema-pop Studio** Application to manage your schemas visually.
* **more llm support** Tools to empower schema use with ai agents.
* **ts to schema** Tool to help converting typescript type definitions into a schema
* **dynamic binary generation** generate purpose built binaries in runtime using bun c compiler
* **binary protocol debugger** with live schema modification support
* **more gpu types support** add support for textures etc.
* **gpu packing code generators** for different targets
