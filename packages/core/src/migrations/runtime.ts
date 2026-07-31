/**
 * User-facing authoring helpers for codec-level migrations.
 *
 * A migration converts a `from`-version decoded object into a `to`-version
 * decoded object. schema-pop auto-derives the mechanical part (copy, rename,
 * widen, default-init) from the plan diff; the user supplies the rest as plain
 * data-transform functions via `defineMigration`.
 *
 * Two shapes are accepted (see the decisions in docs/migrations-plan.md):
 *  - **Per-field mapper** — only the fields auto can't resolve; the rest fall
 *    through to the auto-derived transform.
 *  - **Whole-type mapper** — a single `(v1) => v2` function that owns the
 *    entire conversion for that type (escape hatch).
 */

/** Partial per-field mapper: each entry produces one `to` field from the v1 value. */
export type FieldMapper<From, To> = {
	[K in keyof To]?: (v1: From) => To[K];
};

/** Whole-type mapper: owns the entire v1 → v2 conversion for a type. */
export type WholeMapper<From, To> = (v1: From) => To;

/** Either migration shape for a single type. */
export type Migration<From = any, To = any> =
	| FieldMapper<From, To>
	| WholeMapper<From, To>;

/**
 * Type-helper factory for declaring a v1 → v2 migration for one type. Returns
 * the mapper unchanged — its only job is to give TS inference a hook so every
 * entry is typed against `From` (input) and `To` (output).
 *
 *   // per-field: only override what auto can't derive
 *   const battery = defineMigration<V1.Battery, V2.Battery>({
 *       serial: (v1) => hash(v1.device_id),
 *   });
 *
 *   // whole-type escape hatch
 *   const device = defineMigration<V1.Device, V2.Device>((v1) => ({ ... }));
 */
export function defineMigration<From, To>(
	mapper: Migration<From, To>,
): Migration<From, To> {
	return mapper;
}

/**
 * Registry of user migrations, keyed by the **v2 type name**. Passed to
 * `resolveMigration` so the generator knows which types/fields the user covers
 * (a per-field mapper's own keys, or a whole-type function covering everything)
 * and can hard-error on any uncovered ambiguous change.
 */
export type MigrationHooks = Record<string, Migration>;

/** A whole-type mapper is a function; a per-field mapper is a plain object. */
export function isWholeMapper(m: Migration): m is WholeMapper<any, any> {
	return typeof m === "function";
}

/** The set of `to` field names a per-field mapper covers. */
export function mapperFieldKeys(m: Migration): Set<string> {
	if (isWholeMapper(m)) return new Set();
	return new Set(Object.keys(m));
}
