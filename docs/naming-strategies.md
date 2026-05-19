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

Per-target, set inside the schema file's `schemaPop({ targets: [...] }, scope)` wrap:

```ts
// telemetry.1.pop.ts
import { schemaPop, scope } from "schema-pop";
import { ts, rust } from "@schema-pop/exporter";

export const $ = schemaPop(
    {
        targets: [
            ts({
                dest: "./dist/telemetry.ts",
                fieldNaming: "camelCase",
                typeNaming: "PascalCase",
            }),
            rust({
                dest: "./dist/telemetry.rs",
                fieldNaming: "snake_case",
                typeNaming: "PascalCase",
            }),
        ],
    },
    scope({ ...schemaPop, /* ... */ }),
);
```

The same byte at offset `+4` will be reachable as `voltageLevel` from TypeScript and `voltage_level` from Rust — no manual mapping required.

Most exporters ship sensible defaults (the Rust exporter defaults to `snake_case` / `PascalCase`, TypeScript defaults to `original`, etc.), so you only override when you want to.
