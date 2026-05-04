import { schemaPop, scope } from "schema-pop";

// Declarative field/type system. Adopted from dzielnia for use in
// extension manifests (storage shape declarations, settings forms).

export const $ = schemaPop({}, scope({
	Value: "unknown.any",

	Base: {
		label: "string",
		"typeString?": "string",
		"default?": "Value",
		"description?": "string",
		"required?": "boolean",
		"weight?": "number",
		"example?": "unknown.any",
		"popKind?": "'bitwise' | 'binary' | 'reserved'",
		"size?": "number",
		"align?": "number",
		"binaryType?": "string",
		"scale?": "number",
		"addr?": "number",
		"isBinary?": "boolean",
		"obsolete?": "boolean",
		"obsoleteReason?": "string",
		"renamedFrom?": "string",
	},

	String: {
		"...": "Base",
		type: "'string'",
		"default?": "string",
		"minLength?": "number",
		"maxLength?": "number",
		"pattern?": "string",
	},

	Text: {
		"...": "Base",
		type: "'text'",
		"default?": "string",
		"pattern?": "string",
		"minLength?": "number",
		"maxLength?": "number",
	},

	Number: {
		"...": "Base",
		type: "'number'",
		"default?": "number",
		"min?": "number",
		"max?": "number",
		"step?": "number",
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
		item: "Type",
		"default?": "unknown.any[]",
		"minItems?": "number",
		"maxItems?": "number",
		"additionalItems?": "boolean",
		"uniqueItems?": "boolean",
	},

	Object: {
		"...": "Base",
		"default?": "unknown.any",
		type: "'object'",
		fields: { "[string]": "Type" },
		"additionalProperties?": "boolean",
	},

	Image: {
		"...": "Base",
		type: "'image'",
		"path?": "string",
		"ext?": "string",
		"name?": "string",
		width: "number",
		height: "number",
		"allowedExtensions?": "string[]",
	},

	File: {
		"...": "Base",
		type: "'file'",
		"default?": "unknown.any",
		name: "string",
		ext: "string",
		path: "string",
		"allowedExtensions?": "string[]",
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
		variants: "Type[]",
	},

	SchemaRef: { $ref: "string" },
	Schema: "Record<string, Type> | SchemaRef",
	Type: "String | Text | Number | Boolean | Enum | Array | Object | Image | File | Any | Link | Union",
}));

const { Type: _FormFieldValidator, Schema: _FormSchemaValidator } = $.export();
export type FormField = typeof _FormFieldValidator.infer;
export type FormSchema = typeof _FormSchemaValidator.infer;
