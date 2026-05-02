# Config v2 — co-located, schema-as-truth

Status: **draft / waiting on impl**. Lands as additive API in 0.1.17.
Old `defineConfig({ schemas: [...] })` shape stops working in the same
release — no deprecation tier, both shapes are short-lived enough that
projects upgrade in one go.

## Goals

1. **Schema file is the source of truth.** Adding/moving/removing a schema
   means touching one file, not two.
2. **`pop.config.ts` shrinks to discovery + global flags.** Zero entries
   for the common single-schema project.
3. **Filename = ground truth.** Schema name + version come from the
   file path; no redundant fields inside the schema. The aggregator
   trusts the filename, full stop.

## Non-goals

- Importer integration (clang / tree-sitter). Stays as separate
  `schema-pop-import` CLI — one-off, often manual, opt-in CI step.
- Watch mode and zero-config CLI — separate effort, can layer on top
  once this lands.
- Workspace-of-configs aggregation — wait for a real user.

## New surfaces

### Canonical filename

Schemas live at `**/*.<version>.pop.ts`. Examples:

```
src/konektor.1.0.pop.ts          → schemaName="konektor", version="1.0"
src/konektor.2.0.pop.ts          → schemaName="konektor", version="2.0"
src/telemetry.1.pop.ts           → schemaName="telemetry", version="1"
schemas/wire.0.0.728.pop.ts      → schemaName="wire",      version="0.0.728"
```

Parser: split filename on `.` from the right — last segment is `pop`,
second-to-last is `ts`/`tsx`, third-to-last starts the version string,
everything before that is the schemaName. Filenames that don't match
the pattern are skipped with a warning.

A scaffold helper (`schema-pop new <name> [<version>]`) creates the
file with the right name and a starter template — users never have to
type the version-in-filename convention by hand if they don't want to.

### `schemaPop(config, scope)` — exported from `schema-pop`

```ts
import { schemaPop, scope, schemaPop as schemaPopBundle } from "schema-pop";
import { rust, c, html } from "@schema-pop/core-exporters";

export const $ = schemaPop(
  {
    endian: "le",                  // inherits from defineConfig if omitted
    wordSize: 64,
    autoLayout: true,
    layoutType: "aligned",
    mode: "binary",
    versionNamespace: false,
    targets: [
      rust({}),                    // dest derived from defineConfig.destDir +
      c({}),                       // schemaName + extension; per-target dest
      html({}),                    // override still allowed.
    ],
    extendsTargets: true,          // append to defineConfig.targets;
                                   // false replaces them outright
  },
  scope({
    ...schemaPopBundle,
    Foo: { x: "u32" },
    Bar: { y: "u8" },
  }),
);
```

`schemaName` and `version` are NOT in the config — the aggregator pulls
them from the filename. Removes a class of bugs where the file is
renamed but the field isn't (or vice versa).

Returns an empty (passthrough) interface for now:

```ts
function schemaPop<S>(cfg: SchemaPopConfig, scope: S): S {
  Object.defineProperty(scope, SCHEMA_POP_CONFIG, {
    value: cfg,
    enumerable: false,
  });
  return scope;
}
```

The hidden Symbol-keyed property carries the config. Future builder-
chain API (`schemaPop({...}, scope({...})).withMigrationFrom(...).build()`)
can extend the return type when the need arises.

### `defineConfig(...)` — shrunk

```ts
import { defineConfig } from "schema-pop";
import { rust, html } from "@schema-pop/core-exporters";

export default defineConfig({
  // Discovery — string or string[] (globs). Default: "./**/*.pop.ts"
  // when omitted, so a config-less project still works.
  schemas: "./src/**/*.pop.ts",

  // Output root. Per-schema files land at `<destDir>/<schemaName>.<ext>`
  // unless a target overrides `dest` explicitly.
  destDir: "./dist",

  // Optional defaults inherited by every schema unless overridden.
  endian: "le",
  wordSize: 64,
  mode: "binary",
  targets: [rust({}), html({})],

  // Other features stay where they are:
  bindings: [...],
});
```

A schema file can be passed without a config at all — the CLI assumes
the default discovery glob and global flags. `bunx schema-pop` in a
project root with `src/foo.1.pop.ts` "just works" (output goes to
`./dist/foo.<ext>` for every default-enabled exporter).

## Resolution rules

1. Discover schema files via `defineConfig.schemas` glob(s). Default
   when omitted: `./**/*.pop.ts`.
2. Parse `<schemaName>.<version>.pop.ts` from the basename. Files that
   don't match the pattern: log + continue (don't fail the build).
3. Dynamic-import the file. Locate the exported scope:
   - prefer the export tagged with `__schemaPopConfig`;
   - fall back to duck-typing (`$`, `<schemaName>`, first scope-shaped
     export). Schema files without a `schemaPop()` wrap inherit
     defaults entirely.
4. Build effective config by **merging in this order** (later wins):
   - `defineConfig` global flags
   - `schemaPop()` config block
5. Resolve targets:
   - `extendsTargets: true` (default) → concat `defineConfig.targets`
     + `schemaPop.targets`
   - `extendsTargets: false` → `schemaPop.targets` only
6. Resolve `dest` per target:
   - target plugin's own `dest` wins if set;
   - else `<defineConfig.destDir>/<schemaName>.<extension>`.
7. **Errors during one schema's import or analysis: log + continue
   to the next file.** A bad fixture in a 50-schema project shouldn't
   poison the whole build.

Multi-version: group by parsed `schemaName`, sort by `version` (semver
when valid, lexicographic fallback). Emit migrations between
consecutive versions as we do today. Targets come from the **highest-
version file**; older versions only need a minimal `schemaPop({}, ...)`
or even a plain scope export.

## Multi-version

**Decision: one file per version, schemaName + version both in filename.**
Migration emit walks the version chain in semver order.

```
src/konektor.1.0.pop.ts   →  schemaName="konektor", version="1.0"
src/konektor.1.1.pop.ts   →  schemaName="konektor", version="1.1"
src/konektor.2.0.pop.ts   →  schemaName="konektor", version="2.0"
```

Targets declared on the highest-version file are the ground truth for
that schema's outputs.

Scaffold command (follow-up): `schema-pop new <name> <version>` —
creates `<name>.<version>.pop.ts` with the right shape pre-filled. For
new versions: `schema-pop bump <name> <new-version>` copies the latest
matching file with the version field updated, so the user only edits
the schema body.

## Migration path from 0.1.16 shape

| Current shape                                    | New shape                                  |
|--------------------------------------------------|--------------------------------------------|
| `pop.config.ts` lists schemas + versions + targets | `pop.config.ts` lists schema-file globs + global defaults |
| Schema file `export const $ = scope({...})`      | Schema file `export const $ = schemaPop({...}, scope({...}))` |
| Schema name + version in config                  | Schema name + version in filename (`name.version.pop.ts`) |
| Migration: edit central config + add file        | Migration: rename file (or `schema-pop new`), edit body |

Old shape is **not** kept as a parallel tier — single coordinated
upgrade in 0.1.17, dogfood + scaffold + create templates flip together.
A schema file without the `schemaPop()` wrap is still accepted (treated
as `schemaPop({}, $)` — uses config defaults entirely), so projects
that just have plain `scope({...})` exports get auto-discovered without
edits.

## Resolved decisions (was: open questions)

1. **`schemaPop()` return type** — passthrough `S`, config carried on
   a hidden Symbol. Future builder-chain (`.doSomething()`) layered on
   when needed; no early lock-in.
2. **`destDir`** — only on `defineConfig`. Per-target `dest` overrides
   per-target. One layout-rule per project = one source of truth for
   "where does my generated stuff land".
3. **Schema-file errors** — log and continue. Better DX when iterating
   across many schemas; one bad fixture shouldn't poison the build.
4. **`schemaName` derivation** — canonical filename
   `<name>.<version>.pop.ts`. Filename IS the truth — nothing in the
   schema body to keep in sync.

## Implementation order

1. Add `schemaPop()` factory (core/src/index.ts).
2. Filename parser → `(schemaName, version)`.
3. Extend builder to read `__schemaPopConfig` symbol from imported
   scope; merge with config-level defaults.
4. Glob support in `defineConfig.schemas` (string / string[]).
5. Drop the old `schemas: [{ versions, targets }]` path.
6. Migrate `docs/dogfood/` to the new shape as a self-test.
7. `create-schema-pop` scaffold update.
8. Follow-up: `schema-pop new <name> <version>` and
   `schema-pop bump <name> <new-version>` helpers.
