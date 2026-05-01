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
		"PrimitiveField | ReferenceField | ArrayField | StringField | OptionalField | InlineStructField | UnitField",

	PrimitiveField: {
		"...": "TypeLayout",
		kind: "'primitive'",
		name: "string",
		"bitSize?": "number",
		popKind: "'binary' | 'bitwise' | 'reserved' = 'binary'",
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
	ArrayField,
	EnumPlan,
	EnumVariant,
	Field,
	FieldPlan,
	InlineStructField,
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

export type AliasPlan = typeof AliasPlan.infer;
export type ArrayField = typeof ArrayField.infer;
export type EnumPlan = typeof EnumPlan.infer;
export type EnumVariant = typeof EnumVariant.infer;
export type Field = typeof Field.infer;
export type FieldPlan = typeof FieldPlan.infer;
export type InlineStructField = typeof InlineStructField.infer;
export type OptionalField = typeof OptionalField.infer;
export type PrimitiveField = typeof PrimitiveField.infer;
export type ReferenceField = typeof ReferenceField.infer;
export type StringField = typeof StringField.infer;
export type StructPlan = typeof StructPlan.infer;
export type UnionPlan = typeof UnionPlan.infer;
export type VariantPlan = typeof VariantPlan.infer;
export type TypePlan = typeof TypePlan.infer;
export type TypeLayout = typeof TypeLayout.infer;
export type LayoutConfig = typeof LayoutConfig.infer;
export type LayoutPlan = typeof LayoutPlan.infer;
