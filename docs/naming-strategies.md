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

Per-target, in `pop.config.ts`:

```ts
import { defineConfig } from "schema-pop";
import { ts, rust } from "@schema-pop/core-exporters";

export default defineConfig({
    schemas: [{
        name: "telemetry",
        versions: [{ version: "1.0", source: "./src/telemetry.ts" }],
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
    }],
});
```

The same byte at offset `+4` will be reachable as `voltageLevel` from TypeScript and `voltage_level` from Rust — no manual mapping required.

Most exporters ship sensible defaults (the Rust exporter defaults to `snake_case` / `PascalCase`, TypeScript defaults to `original`, etc.), so you only override when you want to.
