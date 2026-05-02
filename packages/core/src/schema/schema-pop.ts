import { binary } from "./binary";
import { bitwise } from "./bitwise";
import { Reserved, Scale, At, OriginalType } from "./core";
import type { ExporterPlugin } from "./exporter";

/**
 * Carried as a hidden property on the scope returned by `schemaPop()`.
 * `Symbol.for(...)` so different module instances of `schema-pop`
 * (workspace dist vs source, dual-loaded scenarios) all read the same
 * symbol — config never goes missing across module boundaries.
 */
export const SCHEMA_POP_CONFIG = Symbol.for("schema-pop.config");

/**
 * Per-schema-file config carried alongside the arktype scope. The
 * builder reads this during discovery to learn which targets to run,
 * which layout flags apply, etc. Without an explicit `schemaPop()`
 * call a schema file inherits everything from `defineConfig`.
 */
export interface SchemaPopConfig {
	endian?: "le" | "be";
	wordSize?: 32 | 64;
	autoLayout?: boolean;
	layout?: "aligned" | "zero-padding" | "std140" | "std430" | "dynamic";
	mode?: "binary" | "rich";
	versionNamespace?: false | string;
	/**
	 * Exporters this schema should run. By default appended to
	 * `defineConfig.targets`; set `extendsTargets: false` to replace
	 * the global list outright for this one schema.
	 */
	targets?: ExporterPlugin<any>[];
	extendsTargets?: boolean;
}

/**
 * Library of arktype primitives + generics that schema-pop ships,
 * spreadable inside a user `scope({...})`. Same content as the
 * pre-config-v2 `schemaPop` constant.
 */
const aliases = {
	...binary.import(),
	...bitwise.import(),
	"#Reserved": Reserved,
	"#Scale": Scale,
	"#At": At,
	"#OriginalType": OriginalType,
} as const;

/**
 * Wrap an arktype scope with build-time config. Returns the same scope
 * object decorated with a hidden symbol-keyed property so the runtime
 * surface (`.export()`, `.import()`, `...spread`) is unchanged. The
 * builder reads `scope[SCHEMA_POP_CONFIG]` during discovery.
 *
 * ```ts
 * import { schemaPop, scope } from "schema-pop";
 * import { rust, html } from "@schema-pop/core-exporters";
 *
 * export const $ = schemaPop(
 *   { endian: "le", targets: [rust({}), html({})] },
 *   scope({ ...schemaPop, MyType: { x: "u32" } }),
 * );
 * ```
 *
 * The function shares its name with the alias bundle: `...schemaPop`
 * spreads the bundle (it's an Object.assign'd property bag), and
 * `schemaPop({}, scope)` calls the function. One name, both behaviors.
 */
function schemaPopFn<S extends object>(config: SchemaPopConfig, scope: S): S {
	Object.defineProperty(scope, SCHEMA_POP_CONFIG, {
		value: config,
		enumerable: false,
		configurable: false,
		writable: false,
	});
	return scope;
}

/** Runtime extractor — `undefined` for plain scopes (no `schemaPop()` wrap). */
export function getSchemaPopConfig(scope: unknown): SchemaPopConfig | undefined {
	if (typeof scope !== "object" || scope === null) return undefined;
	return (scope as { [SCHEMA_POP_CONFIG]?: SchemaPopConfig })[SCHEMA_POP_CONFIG];
}

/**
 * Convenience export covering both call sites:
 *  - `schemaPop({...}, scope({...}))` — wrap with config
 *  - `scope({ ...schemaPop, MyType: {...} })` — spread the alias bundle
 *
 * Type: `(config, scope) => S` callable + the bundle's keys.
 */
export const schemaPop: typeof schemaPopFn & typeof aliases = Object.assign(
	schemaPopFn,
	aliases,
);
