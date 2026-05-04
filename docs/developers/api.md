# API architecture

## Packages

| Package | Description |
|---|---|
| `schema-pop` | Core types, analyzer, migrations, codec. Browser-safe. |
| `schema-pop/node` | Core + Node/Bun-only APIs: `readLayoutPlan`, `writeLayoutPlan`, `buildSchema`. |
| `@schema-pop/treesitter-importer` | Source-file → IR importer for 15 languages. |
| `@schema-pop/core-exporters` | Schema exporters (C, C++, Rust, Go, Zig, TS) + code migration compilers. |
| `@schema-pop/extra-exporters` | HTML viewer, WGSL, Nuxt UI, and other higher-level exporters. |

---

## Schema representations

There are four distinct formats in schema-pop, each at a different abstraction level.

```
Source file (.rs / .go / .py / …)        pop.ts (ArkType scope)
        │                                         │
        ▼  @schema-pop/treesitter-importer        │ schema-pop/node  [needs jiti]
   SchemaPopIR  ──── emitArktypeScope ──► pop.ts  │ bindFile / buildSchema
        │                                         │
        └──────────────────┬──────────────────────┘
                           ▼
                      LayoutPlan  ◄──── readLayoutPlan(.layout.json)
                           │
              ┌────────────┼────────────┐
              ▼            ▼            ▼
           C / Rust      HTML        WGSL / …
        (code export)  (viewer)    (schema export)


ArkType scope ──[fromArktype]──► FormField JSON ──► (network / DB / file)
                                       │
                                 [getArkType]
                                       │
                                       ▼
                               ArkType Type  (runtime validation, browser-safe)
```

### 1. `SchemaPopIR` — tree-sitter walker output

`packages/core/src/ir.ts`

Raw extraction from source AST. Language-agnostic struct/enum/union list with unresolved field types as strings. Ephemeral — not serialized to disk.

### 2. `LayoutPlan` — binary layout

`packages/core/src/schema/layout.ts`

The primary IR for binary exporters. Carries exact byte offsets, sizes, and alignments. Produced by `computeLayoutPlan(scope)`, serialized to `.layout.json`.

### 3. `FormField` — form-field descriptor

`packages/core/src/schema/fields.pop.ts`

Plain JSON-serializable descriptor tree for the field system (strings, numbers, enums, objects, arrays, links). Bidirectionally converted to/from ArkType via `fromArktype` / `getArkType`. Can be persisted and transferred without a TS runtime — `getArkType` reconstructs a live validator from the JSON on the other side.

### 4. `AST` / `CodeStructure` — code analysis

`packages/core/src/schema/ast.ts`

Graph of files, nodes, symbols, and types for documentation or analysis (Gimli importer target). Not used by binary exporters.

---

## Import API

### From a source file (tree-sitter)

```ts
import { importFile, fileToArktypeScope } from "@schema-pop/treesitter-importer";

// → SchemaPopIR (in-memory)
const ir = await importFile("src/types.rs");
const ir = await importFile("src/types.go", "go");  // explicit lang

// → ready-to-save .pop.ts source string
const popTs = await fileToArktypeScope("src/types.rs", { typeNaming: "PascalCase" });
```

Language is inferred from file extension. TypeScript (`.ts`) is NOT auto-inferred — pass
`lang: "typescript"` explicitly to avoid silently treating pop.ts files as importable interfaces.

### From a pop.ts file

`buildSchema` is a batch pipeline (config + glob patterns + `rootDir`) — not a one-shot importer.
For a single file, use jiti directly:

```ts
import { createJiti } from "jiti";
import { isArktypeScope, computeLayoutPlan } from "schema-pop/node";

const jiti = createJiti(import.meta.url);
const mod = await jiti.import("/abs/path/to/telemetry.1.pop.ts") as Record<string, unknown>;
const scope = Object.values(mod).find(isArktypeScope);
if (!scope) throw new Error("no arktype scope found");
const plan = computeLayoutPlan(scope);
```

> **Gap:** `importPopTs(path) → Promise<LayoutPlan>` helper in `schema-pop/node`.

### From a .layout.json file

```ts
import { readLayoutPlan } from "schema-pop/node";

const plan = await readLayoutPlan("dist/telemetry.v1.layout.json");
```

> **Gap:** `readLayoutPlan` should be promoted to the main `schema-pop` entry so browser/edge
> runtimes receiving layout JSON over the network can use it without the node-only bundle.

---

## FormField codec

Converts between ArkType `Type` objects and the `FormField` descriptor tree.
Both directions are pure — no file I/O, no jiti, browser-safe.

```ts
import { fromArktype, getArkType, type FormField } from "schema-pop";

// ArkType scope → FormField JSON  (e.g. after loading a pop.ts with jiti)
const exported = myScope.export();
const field = fromArktype(exported.MyStruct, {
  scopeId: "my-schema",
  scopeExports: exported,   // optional: turns alias shapes into link refs
});

// Serialize / transfer / store as plain JSON
const json = JSON.stringify(field);

// FormField JSON → ArkType Type  (browser-safe, no jiti)
const field2: FormField = JSON.parse(json);
const validator = getArkType(field2);
validator({ ... }); // runtime validation
```

The jiti boundary is only at the `.pop.ts` load step. Everything after — including reconstructing
validators from stored `FormField` JSON — runs in any JS environment.

---

## Export API

All exporters implement `ExporterPlugin` from `schema-pop`:

```ts
interface ExporterPlugin<TConfig> {
  name: string;
  extension?: string;
  generate(plan: LayoutPlan): string | Record<string, string>;
  generateMigration?(from: LayoutPlan, to: LayoutPlan): string;
  getFileHeader?(): string;
  getFileFooter?(): string;
  getHarness?(plans: LayoutPlan[]): Record<string, string>;
  getIndex?(files: { dest: string; schemaName: string }[]): Record<string, string>;
}
```

### Schema exporters

```ts
import { c, cpp, rust, go, zig, ts } from "@schema-pop/core-exporters";
import { html, wgsl } from "@schema-pop/extra-exporters";

const plugin = rust();
const code = plugin.generate(plan);
const diff = plugin.generateMigration!(v1, v2);
```

### Code migration compilers

```ts
import { compileCMigration, compileRustMigration } from "@schema-pop/core-exporters";

// Compiles a TS erasable-syntax migration function → C / Rust raw-buffer function.
const cCode    = await compileCMigration(tsSource, fromPlan, toPlan);
const rustCode = await compileRustMigration(tsSource, fromPlan, toPlan);
```

See [code-exporters.md](../exporters/code-exporters.md) for full expression coverage.

### HTML diff viewer

```ts
import { html } from "@schema-pop/extra-exporters";
import { readLayoutPlan } from "schema-pop/node";

const plugin = html();
const v1 = await readLayoutPlan("v1.layout.json");
const v2 = await readLayoutPlan("v2.layout.json");

const file =
  plugin.getFileHeader!() +
  plugin.generate(v1) +
  plugin.generate(v2) +
  plugin.generateMigration!(v1, v2) +
  plugin.getFileFooter!();
```

---

## Current gaps

| Gap | Location | Notes |
|---|---|---|
| `readLayoutPlan` not in `schema-pop` | `core/src/index.ts` | Move out of node-only entry |
| No `importPopTs(path)` → `LayoutPlan` | `schema-pop/node` | Wrap jiti + `isArktypeScope` + `computeLayoutPlan` |
| Code exporters: TS passthrough | `core-exporters/src/code/` | TS is already the source — trivially a no-op, needs a stub |
