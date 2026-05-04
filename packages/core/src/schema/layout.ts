import { scope, type } from "arktype";
import { binary } from "./binary";

/**
 *
 * Core schema definitions for the Linear Layout Plan (LLP).
 */
export const $layout = scope({
	...binary.import(),

	VersionNumber: type("string").pipe((v) => {
		let slug = v.replace(/[.-]/g, "_").replace(/[^a-zA-Z0-9_]/g, "");
		if (/^[0-9]/.test(slug)) {
			slug = `v${slug}`;
		}
		return slug;
	}),

	/** Unified layout information for any element */
	TypeLayout: {
		size: "number",
		align: "number",
		paddedSize: "number",
	},

	/** Recursive field definition */
	Field:
		"PrimitiveField | ReferenceField | ArrayField | StringField | OptionalField | InlineStructField | UnitField | MapField | AnyField",

	PrimitiveField: {
		"...": "TypeLayout",
		kind: "'primitive'",
		name: "string",
		"bitSize?": "number",
		popKind: "'binary' | 'bitwise' | 'reserved' | 'rich' = 'binary'",
	},

	/**
	 * Index-signature / Record<K, V>. No fixed memory layout; binary-tier
	 * exporters should skip these with a warning. `value` is recursive Field.
	 */
	MapField: {
		kind: "'map'",
		keyKind: "'string' | 'number' | 'symbol' = 'string'",
		value: "Field",
	},

	/**
	 * arktype `unknown` / `any` / `unknown.any`. Carries no shape info;
	 * exporters that can render an opaque value (TS `unknown`, JSON `any`)
	 * may emit it; binary-tier exporters skip with a warning.
	 *
	 * Importers that fall back to `any` because they couldn't resolve a
	 * source type (e.g. clang_importer hitting `size_t` with no
	 * `<stddef.h>` available, or `const char *` which has no schema-pop
	 * equivalent) attach the original spelling on `originalType` so
	 * downstream tooling can recover the user's intent later — pop it
	 * back to a real type once we model that shape, drive a manual
	 * binding emit, render in HTML viewer, etc.
	 */
	AnyField: {
		kind: "'any'",
		"originalType?": "string",
	},

	ReferenceField: {
		kind: "'reference'",
		name: "string",
		indirection: "'inline' | 'pointer' | 'reference'",
		isForward: "boolean",
	},

	ArrayField: {
		kind: "'array'",
		item: "Field",
		"maxLength?": "number",
		"exactLength?": "number",
	},

	StringField: {
		kind: "'string'",
		"maxLength?": "number",
	},

	OptionalField: {
		kind: "'optional'",
		inner: "Field",
	},

	UnitField: {
		kind: "'unit'",
	},

	/** A specific instance of a field within a structure */
	FieldPlan: {
		name: "string",
		type: "Field",
		offset: "number",
		bitOffset: "number<8",
		bitSize: "number",
		size: "number",
		paddingAfter: "number",
		"description?": "string",
		"obsolete?": "boolean",
		"obsoleteReason?": "string",
		// `migrationMeta?: MigrationMeta` is added as a TS-only field on the
		// exported types — keeping it out of the arktype scope here avoids
		// tipping inference past the TS serialization limit.
	},

	InlineStructField: {
		"...": "TypeLayout",
		kind: "'inlineStruct'",
		fields: "FieldPlan[]",
	},

	VariantPlan: {
		name: "string",
		type: "Field",
	},

	/** Top-level type definitions */
	StructPlan: {
		"...": "TypeLayout",
		kind: "'struct'",
		name: "string",
		fields: "FieldPlan[]",
		"description?": "string",
		"obsolete?": "boolean",
		"obsoleteReason?": "string",
	},

	UnionPlan: {
		"...": "TypeLayout",
		kind: "'union'",
		name: "string",
		tagOffset: "number",
		tagSize: "number",
		tagType: "'u8' | 'u16' | 'u32'",
		variants: "VariantPlan[]",
		"description?": "string",
		"obsolete?": "boolean",
		"obsoleteReason?": "string",
	},

	EnumVariant: {
		name: "string",
		value: "number",
		description: "string?",
	},

	EnumPlan: {
		"...": "TypeLayout",
		kind: "'enum'",
		name: "string",
		variants: "EnumVariant[]",
		underlyingType: "'u8' | 'u16' | 'i32'",
		"description?": "string",
		"obsolete?": "boolean",
		"obsoleteReason?": "string",
	},

	AliasPlan: {
		"...": "TypeLayout",
		kind: "'alias'",
		name: "string",
		type: "Field",
		"description?": "string",
		"obsolete?": "boolean",
		"obsoleteReason?": "string",
	},

	TypePlan: "StructPlan | UnionPlan | EnumPlan | AliasPlan",

	LayoutConfig: {
		endian: "'le' | 'be' = 'le'",
		autoLayout: "boolean=true",
		wordSize: "32 | 64=64",
	},

	/** The complete Linear Layout Plan (LLP) */
	LayoutPlan: {
		"...": "LayoutConfig",
		types: "TypePlan[]",
		version: "VersionNumber",
	},
});

export const {
	AliasPlan,
	AnyField,
	ArrayField,
	EnumPlan,
	EnumVariant,
	Field,
	FieldPlan,
	InlineStructField,
	MapField,
	OptionalField,
	PrimitiveField,
	ReferenceField,
	StringField,
	StructPlan,
	UnionPlan,
	VariantPlan,
	TypePlan,
	TypeLayout,
	LayoutConfig,
	LayoutPlan,
} = $layout.export();

/**
 * Migration-time metadata attached to fields and types.
 * - `renamedFrom`: from `Renamed<T, "oldName">` marker.
 * - `defaultValue`: from ArkType native default (`"T = value"`).
 * Plain TS type — not in the arktype scope (would push inference past
 * the TS serialization limit).
 */
export type MigrationMeta = {
	renamedFrom?: string;
	defaultValue?: unknown;
};

export type AnyField = typeof AnyField.infer;
export type ArrayField = typeof ArrayField.infer;
export type Field = typeof Field.infer;
export type InlineStructField = typeof InlineStructField.infer;
export type MapField = typeof MapField.infer;
export type OptionalField = typeof OptionalField.infer;
export type PrimitiveField = typeof PrimitiveField.infer;
export type ReferenceField = typeof ReferenceField.infer;
export type StringField = typeof StringField.infer;
export type TypeLayout = typeof TypeLayout.infer;
export type LayoutConfig = typeof LayoutConfig.infer;

// Plans that carry migrationMeta — TS-only addition on top of the arktype
// scope, since adding it inside the scope tips TS inference past the
// serialization limit.
export type FieldPlan = typeof FieldPlan.infer & {
	migrationMeta?: MigrationMeta;
};
export type VariantPlan = typeof VariantPlan.infer & {
	migrationMeta?: MigrationMeta;
};
export type EnumVariant = typeof EnumVariant.infer & {
	migrationMeta?: MigrationMeta;
};
export type StructPlan = Omit<typeof StructPlan.infer, "fields"> & {
	fields: FieldPlan[];
	migrationMeta?: MigrationMeta;
};
export type UnionPlan = Omit<typeof UnionPlan.infer, "variants"> & {
	variants: VariantPlan[];
	migrationMeta?: MigrationMeta;
};
export type EnumPlan = Omit<typeof EnumPlan.infer, "variants"> & {
	variants: EnumVariant[];
	migrationMeta?: MigrationMeta;
};
export type AliasPlan = typeof AliasPlan.infer & {
	migrationMeta?: MigrationMeta;
};
export type TypePlan = StructPlan | UnionPlan | EnumPlan | AliasPlan;

/**
 * Function arg — `name` is optional because C/C++ headers often elide
 * argument names. `type` reuses the same Field union as struct fields.
 *
 * Defined as a plain TS type (not part of the arktype scope) because
 * adding it inside `$layout` tips inference past TS7056. Importers
 * produce these as plain objects; analyzer doesn't synthesize them.
 */
export type FunctionArg = {
	name?: string;
	type: Field;
};

/**
 * A function declaration extracted from source (tree-sitter / clang
 * importers). Carries enough info to emit FFI bindings, dlsym wrappers,
 * or doc.
 *
 * Mangled `symbol` is filled at clang level; tree-sitter level only
 * has unmangled identifiers (Rust + `extern "C"` C/C++ symbols match
 * the source name 1:1, so `symbol` defaults to `name`).
 */
export type FunctionPlan = {
	name: string;
	symbol?: string;
	returnType: Field;
	args: FunctionArg[];
	/** Calling convention. Common values: `C`, `cdecl`, `stdcall`, `fastcall`, `system`. */
	abi?: string;
	async?: boolean;
	throws?: boolean;
	description?: string;
	obsolete?: boolean;
	obsoleteReason?: string;
	renamedFrom?: string;
};

export type LayoutPlan = Omit<typeof LayoutPlan.infer, "types"> & {
	types: TypePlan[];
	functions?: FunctionPlan[];
};
