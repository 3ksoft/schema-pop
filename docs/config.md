# Config

Three pieces. Filename is the source of truth; per-schema config lives next to the data.

## 1. `pop.config.ts`

```ts
import { defineConfig } from "schema-pop";

export default defineConfig({
	endian: "le",
	wordSize: 64,
});
```

Fields, all optional:

| Field        | Default            | Notes                                                                  |
|--------------|--------------------|------------------------------------------------------------------------|
| `schemas`    | `./**/*.pop.ts`    | Glob string or `string[]`. Discovery only — no entries to enumerate.   |
| `destDir`    | —                  | Output root. Per-target `dest` overrides; otherwise `<destDir>/<schemaName>.<ext>`. |
| `endian`     | `"le"`             | `"le" \| "be"` — applied to every schema unless overridden.            |
| `wordSize`   | `64`               | `32 \| 64`.                                                            |
| `autoLayout` | `true`             | Reorder fields by alignment. Off for `#[repr(C)]` interop.             |
| `layout`     | `"aligned"`        | `"aligned" \| "zero-padding" \| "std140" \| "std430" \| "dynamic"`.    |
| `mode`       | `"binary"`         | `"binary" \| "rich"` — rich allows unbounded primitives.               |
| `targets`    | —                  | Default exporter set, appended to each schema's targets.               |
| `bindings`   | —                  | `BindingSpec[]` for `schema-pop bind`. Unrelated to schema build.      |

`bunx schema-pop` works without a config — defaults above kick in.

## 2. Schema filenames

The default discovery glob (`./**/*.pop.ts`) plus the basename rule below is **convention** — what the parser uses when nothing else tells it otherwise. Both layers can be overridden: the glob via `defineConfig.schemas`, and the parsed `schemaName` / `version` via the schema's own `schemaPop({ schemaName, version }, scope)` config (see section 3).

```
<schemaName>.<version>.pop.ts(x)
```

```
src/konektor.1.0.pop.ts        → name "konektor", version "1.0"
src/konektor.1.1.pop.ts        → name "konektor", version "1.1"
src/konektor.2.0.pop.ts        → name "konektor", version "2.0"
schemas/wire.0.0.728.pop.ts    → name "wire",     version "0.0.728"
```

Rule: split off `.tsx?$`, then `.pop$`, then everything before the first remaining `.` is the schema name; the rest is the version. Schema names can't contain dots.

Files that don't match the pattern are logged and skipped **unless** their `schemaPop({...})` call sets both `schemaName` and `version` — in which case the config wins and the file joins the build as if it were named `<schemaName>.<version>.pop.ts`. Useful for importer-generated files (`wifi-types.gen.ts` etc.) you don't want to rename.

Multi-version: group by name, sort by version (semver, lexicographic fallback), migration emit between consecutive versions. Targets come from the highest-version file; older versions can stay plain `scope({})` exports.

## 3. Schema configuration

Targets and per-schema flags live inside the schema file:

```ts
import { schemaPop, scope } from "schema-pop";
import { rust, c, html } from "@schema-pop/core-exporters";

export const $ = schemaPop(
	{
		targets: [
			rust({ dest: "./dist/konektor.rs" }),
			c({}),                                // dest = <destDir>/konektor.h
			html({}),                             // dest = <destDir>/konektor.html
		],
	},
	scope({
		...schemaPop,
		Foo: { x: "u32" },
		Bar: { y: "u8" },
	}),
);
```

`schemaPop` is callable AND spreadable: `schemaPop({}, scope)` wraps; `...schemaPop` is the alias bundle (binary primitives, bitwise primitives, Reserved/Scale/At/OriginalType generics).

`SchemaPopConfig` fields, all optional:

| Field             | Default        | Notes                                                                |
|-------------------|----------------|----------------------------------------------------------------------|
| `schemaName`      | from filename  | Override the parsed name. Must be set together with `version`.       |
| `version`         | from filename  | Override the parsed version. Must be set together with `schemaName`. |
| `targets`         | —              | Exporters to run for this schema. See `extendsTargets`.              |
| `extendsTargets`  | `true`         | Append to `defineConfig.targets`. `false` replaces them outright.    |
| `endian`          | inherited      | Per-schema override.                                                 |
| `wordSize`        | inherited      | Per-schema override.                                                 |
| `autoLayout`      | inherited      | Per-schema override.                                                 |
| `layout`          | inherited      | Per-schema override (e.g. `"std430"` for one GPU schema).            |
| `mode`            | inherited      | Per-schema override.                                                 |
| `versionNamespace`| `undefined`    | `false` drops `<name>_<version>_` prefix in Rust + C output.         |

The wrap is optional — a plain `export const $ = scope({...})` works too and inherits everything from `defineConfig`.

### Multi-version

Put each version in its own file. Wrap the **latest** with `schemaPop({ targets, ... })`; older versions can stay bare:

```ts
// konektor.1.0.pop.ts
export const $ = scope({ ...schemaPop, ... });

// konektor.2.0.pop.ts
export const $ = schemaPop(
	{ targets: [rust({}), html({})] },
	scope({ ...schemaPop, ... }),
);
```

The builder picks targets from the highest-version file and emits migrations between consecutive versions in semver order.

### `dest` resolution

Per-target `dest` wins when set. Otherwise the builder uses `<destDir>/<schemaName>.<extension>` where `extension` is each plugin's declared default (`rs` / `h` / `hpp` / `ts` / `html` / `wgsl` / etc.).
