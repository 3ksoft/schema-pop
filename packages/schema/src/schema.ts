import { regex } from "arkregex";
import type { Module, Type } from "arktype";
import { scope, type } from "arktype";

export type PopModule = Module<Record<string, Type<unknown>>>;

export interface ExtractionContext {
	warnings: string[];
	errors: string[];
	schema: PopSchema;
	map: Map<string, string>;
	module: PopModule;
}

export const SemVer = regex(
	"^(?<major>\\d+)\\.(?<minor>\\d+)\\.(?<patch>\\d+)$",
);

export const $ = scope({
	VersionNumber: type("string").pipe((v) => {
		let slug = v.replace(/[.-]/g, "_").replace(/[^a-zA-Z0-9_]/g, "");
		if (/^[0-9]/.test(slug)) {
			slug = `v${slug}`;
		}
		return slug;
	}),
	Base: {
		// Field kind
		"popKind?": "'rich' | 'bitwise' | 'binary' | 'reserved'",

		// Rich
		"label?": "string",
		"typeString?": "string",
		"default?": "unknown.any",
		"description?": "string",
		"required?": "boolean",
		"weight?": "number",
		"example?": "unknown.any",

		// Binary Metadata
		"size?": "number",
		"align?": "number",
		"binaryType?": "string",
		"scale?": "number",
		"addr?": "number",
		"isBinary?": "boolean",
		"obsolete?": "boolean",
		"obsoleteReason?": "string",
		"renamedFrom?": "string",
		"originalType?": "string",
	},

	String: {
		"...": "Base",
		type: "'string'",
		"default?": "string",
		"minLength?": "number",
		"maxLength?": "number",
		"exactLength?": "number",
		"pattern?": "string",
	},

	Symbol: {
		"...": "Base",
		type: "'symbol'",
		value: "string",
	},
	Number: {
		"...": "Base",
		type: "'number'",
		"default?": "number",
		"min?": "number",
		"max?": "number",
		"step?": "number",
	},

	Bigint: {
		"...": "Base",
		type: "'bigint'",
		"default?": "bigint",
		"min?": "bigint",
		"max?": "bigint",
		"step?": "bigint",
	},

	Boolean: {
		"...": "Base",
		type: "'boolean'",
		"default?": "boolean",
	},

	EnumOption: {
		label: "string",
		value: "string | number",
	},

	Enum: {
		"...": "Base",
		type: "'enum'",
		options: "string[] | EnumOption[]",
		"default?": "string | number",
	},

	Array: {
		"...": "Base",
		type: "'array'",
		item: "PopType",
		"default?": "unknown.any[]",
		"minLength?": "number",
		"exactLength?": "number",
		"maxLength?": "number",
		"additionalItems?": "boolean",
		"uniqueItems?": "boolean",
	},

	Object: {
		"...": "Base",
		"default?": "unknown.any",
		type: "'object'",
		fields: { "[string]": "PopType" },
		"additionalProperties?": "boolean",
	},

	Any: {
		"...": "Base",
		type: "'any'",
		"default?": "unknown.any",
	},

	Link: {
		"...": "Base",
		type: "'link'",
		target: "string",
		"spread?": "boolean",
	},

	Union: {
		"...": "Base",
		type: "'union'",
		variants: "PopType[]",
		"discriminant?": "string",
	},

	Unit: {
		"...": "Base",
		type: "'unit'",
	},

	PopFunction: {
		type: "'function'",
		args: "PopType[]",
		returns: "PopType",
		"abi?": "string",
		"description?": "string",
		"symbol?": "string",
		"obsolete?": "boolean",
		"obsoleteReason?": "string",
	},

	LayoutType:
		"'aligned' | 'zero-padding' | 'std140' | 'std430' | 'dynamic' | 'dbus'",

	PopSchemaSettings: {
		"schemaName?": "string",
		endian: "'le' | 'be' = 'le'",
		wordSize: "'32' | '64' = '64'",
		autoLayout: "boolean = true",
		layout: "LayoutType = 'aligned'",
		mode: "'binary' | 'rich' = 'binary'",
		"version?": SemVer,
	},
	PopSchema: {
		"...": "PopSchemaSettings",
		types: "Record<string, PopType>",
		functions: "Record<string, PopFunction>",
	},
	PopType:
		"String | Symbol | Number | Boolean | Enum | Array | Object | Any | Link | Union | Unit",
});

const schema = $.export();

export const {
	VersionNumber,
	Base,
	String,
	Symbol,
	Number,
	Boolean,
	Enum,
	EnumOption,
	Array,
	Object,
	Any,
	Link,
	Union,
	PopFunction,
	PopSchemaSettings,
	PopSchema,
	PopType,
} = schema;

export type Base = typeof Base.infer;
export type String = typeof String.infer;
export type Symbol = typeof Symbol.infer;
export type Number = typeof Number.infer;
export type Boolean = typeof Boolean.infer;
export type Enum = typeof Enum.infer;
export type EnumOption = typeof EnumOption.infer;
export type Array = typeof Array.infer;
export type Object = typeof Object.infer;
export type Any = typeof Any.infer;
export type Link = typeof Link.infer;
export type Union = typeof Union.infer;
export type PopFunction = typeof PopFunction.infer;
export type PopSchemaSettings = typeof PopSchemaSettings.inferIn;
export type PopSchema = typeof PopSchema.infer;
export type PopType = typeof PopType.infer;
