import { type, scope } from "arktype";
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
	 */
	AnyField: {
		kind: "'any'",
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
export type EnumVariant = typeof EnumVariant.infer;
export type Field = typeof Field.infer;
export type InlineStructField = typeof InlineStructField.infer;
export type MapField = typeof MapField.infer;
export type OptionalField = typeof OptionalField.infer;
export type PrimitiveField = typeof PrimitiveField.infer;
export type ReferenceField = typeof ReferenceField.infer;
export type StringField = typeof StringField.infer;
export type VariantPlan = typeof VariantPlan.infer;
export type TypeLayout = typeof TypeLayout.infer;
export type LayoutConfig = typeof LayoutConfig.infer;

// Plans that carry migrationMeta — TS-only addition on top of the arktype
// scope, since adding it inside the scope tips TS inference past the
// serialization limit.
export type FieldPlan = typeof FieldPlan.infer & {
	migrationMeta?: MigrationMeta;
};
export type StructPlan = Omit<typeof StructPlan.infer, "fields"> & {
	fields: FieldPlan[];
	migrationMeta?: MigrationMeta;
};
export type UnionPlan = typeof UnionPlan.infer & {
	migrationMeta?: MigrationMeta;
};
export type EnumPlan = typeof EnumPlan.infer & {
	migrationMeta?: MigrationMeta;
};
export type AliasPlan = typeof AliasPlan.infer & {
	migrationMeta?: MigrationMeta;
};
export type TypePlan = StructPlan | UnionPlan | EnumPlan | AliasPlan;
export type LayoutPlan = Omit<typeof LayoutPlan.infer, "types"> & {
	types: TypePlan[];
};
