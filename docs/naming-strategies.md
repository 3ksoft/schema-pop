# Naming strategies

To bridge language conventions (`snake_case` in Rust, `camelCase` in TypeScript, `PascalCase` for type names) without changing the schema source, every exporter accepts independent `fieldNaming` and `typeNaming` strategies.

## Supported strategies

| Strategy       | Typical use                                |
| -------------- | ------------------------------------------ |
| `snake_case`   | Rust / C / Zig field names                 |
| `camelCase`    | TypeScript / C++ field names               |
| `PascalCase`   | Standard for type/struct names everywhere  |
| `original`     | Preserve the exact name from the schema    |

## Configuration

Pass `fieldNaming` / `typeNaming` in each exporter's config:

```ts
import { fromModule, SchemaAnalyzer } from "@schema-pop/core";
import { exportPlan } from "@schema-pop/exporter";
import { $ } from "./telemetry.1"; // an ArkType module

const { plan } = new SchemaAnalyzer().analyze(fromModule($.export()), {});

const tsCode = exportPlan(plan, "ts", {
    fieldNaming: "camelCase",
    typeNaming: "PascalCase",
});
const rustCode = exportPlan(plan, "rust", {
    fieldNaming: "snake_case",
    typeNaming: "PascalCase",
});
```

The same byte at offset `+4` will be reachable as `voltageLevel` from TypeScript and `voltage_level` from Rust — no manual mapping required.

Most exporters ship sensible defaults (the Rust exporter defaults to `snake_case` / `PascalCase`, TypeScript defaults to `original`, etc.), so you only override when you want to.
