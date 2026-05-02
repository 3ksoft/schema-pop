import type {
	BaseConfig,
	ExporterPlugin,
	Field,
	LayoutPlan,
	TypePlan,
} from "schema-pop";

export interface JsonSchemaConfig extends BaseConfig {
	/**
	 * `$schema` URL written at the document root. Defaults to JSON Schema
	 * 2020-12 — the current published draft. Override if you target an
	 * older validator (e.g. Ajv strict mode pinned to draft-07).
	 */
	schemaUri?: string;
	/**
	 * Optional `$id` base. Each schema gets `<idBase>/<schemaName>.json`.
	 * Leave unset to produce a self-contained doc with no `$id`.
	 */
	idBase?: string;
	/**
	 * Pretty-print the JSON output. On by default — these files land in
	 * docs and humans read them. Set `false` for compact output.
	 */
	pretty?: boolean;
	/**
	 * Include schema-pop metadata as `x-schema-pop` extension keys
	 * (popKind, size, align, addr, scale, isBinary, originalType, …).
	 * Off by default — turn on when consumers need the binary-layout
	 * sidecar info, leave off for plain documentation.
	 */
	includeExtensions?: boolean;
}

interface JsonSchemaNode {
	type?: string | string[];
	enum?: unknown[];
	const?: unknown;
	properties?: Record<string, JsonSchemaNode>;
	required?: string[];
	additionalProperties?: boolean | JsonSchemaNode;
	items?: JsonSchemaNode;
	$ref?: string;
	oneOf?: JsonSchemaNode[];
	anyOf?: JsonSchemaNode[];
	format?: string;
	minimum?: number;
	maximum?: number;
	minLength?: number;
	maxLength?: number;
	description?: string;
	deprecated?: boolean;
	default?: unknown;
	[key: `x-${string}`]: unknown;
}

const INT_RANGES: Record<string, { min: number; max: number; format?: string }> = {
	u8: { min: 0, max: 255 },
	u16: { min: 0, max: 65535 },
	u32: { min: 0, max: 4294967295, format: "uint32" },
	u64: { min: 0, max: Number.MAX_SAFE_INTEGER, format: "uint64" },
	i8: { min: -128, max: 127 },
	i16: { min: -32768, max: 32767 },
	i32: { min: -2147483648, max: 2147483647, format: "int32" },
	i64: { min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER, format: "int64" },
};

const FLOAT_FORMATS: Record<string, string> = {
	f32: "float",
	f64: "double",
};

export function jsonSchema(
	config: JsonSchemaConfig = {},
): ExporterPlugin<JsonSchemaConfig> {
	const cfg: JsonSchemaConfig = {
		commentStyle: "none",
		pretty: true,
		...config,
	};

	function refOf(name: string): JsonSchemaNode {
		return { $ref: `#/$defs/${name}` };
	}

	function fieldNode(field: Field): JsonSchemaNode {
		const fAny = field as Record<string, unknown>;
		switch (field.kind) {
			case "primitive": {
				const name = (field as { name: string }).name;
				if (name === "bool" || name === "boolean") {
					return { type: "boolean" };
				}
				if (name in INT_RANGES) {
					const r = INT_RANGES[name]!;
					const node: JsonSchemaNode = {
						type: "integer",
						minimum: r.min,
						maximum: r.max,
					};
					if (r.format) node.format = r.format;
					return node;
				}
				if (name in FLOAT_FORMATS) {
					return { type: "number", format: FLOAT_FORMATS[name]! };
				}
				if (name === "number") return { type: "number" };
				if (name === "bigint") return { type: "integer", format: "int64" };
				if (name === "string") return { type: "string" };
				return {};
			}
			case "string": {
				const node: JsonSchemaNode = { type: "string" };
				const max = fAny.maxLength as number | undefined;
				const min = fAny.minLength as number | undefined;
				if (typeof max === "number") node.maxLength = max;
				if (typeof min === "number") node.minLength = min;
				return node;
			}
			case "array":
				return {
					type: "array",
					items: fieldNode((field as { item: Field }).item),
				};
			case "optional":
				return fieldNode((field as { inner: Field }).inner);
			case "map": {
				const value = (field as { value: Field }).value;
				return {
					type: "object",
					additionalProperties: fieldNode(value),
				};
			}
			case "reference":
				return refOf((field as { name: string }).name);
			case "inlineStruct": {
				const node: JsonSchemaNode = {
					type: "object",
					properties: {},
					required: [],
				};
				for (const f of (field as { fields: Array<{ name: string; type: Field }> })
					.fields) {
					if (f.type.kind === "unit") continue;
					node.properties![f.name] = fieldNode(f.type);
					if (f.type.kind !== "optional") node.required!.push(f.name);
				}
				if (node.required!.length === 0) delete node.required;
				return node;
			}
			case "any":
				return {};
			case "unit":
				return { type: "null" };
			default:
				return {};
		}
	}

	function attachMeta(node: JsonSchemaNode, meta: Record<string, unknown>): void {
		// `$ref` nodes shouldn't carry sibling description / x-* keys —
		// older JSON Schema drafts ignore them and the auto-generated
		// arktype description ("{ x: non-negative... }") just adds noise.
		if (node.$ref) return;
		if (typeof meta.description === "string") node.description = meta.description;
		if (meta.obsolete) {
			node.deprecated = true;
			if (typeof meta.obsoleteReason === "string") {
				node.description =
					(node.description ? node.description + " — " : "") +
					`DEPRECATED: ${meta.obsoleteReason}`;
			}
		}
		if (cfg.includeExtensions) {
			for (const k of [
				"popKind",
				"size",
				"align",
				"addr",
				"scale",
				"isBinary",
				"binaryType",
				"originalType",
				"renamedFrom",
			]) {
				const v = meta[k];
				if (v !== undefined) node[`x-${k}`] = v;
			}
		}
	}

	function renderType(t: TypePlan): JsonSchemaNode {
		const meta = t as unknown as Record<string, unknown>;
		if (t.kind === "struct") {
			const node: JsonSchemaNode = {
				type: "object",
				properties: {},
				required: [],
			};
			for (const f of t.fields) {
				if (f.type.kind === "unit") continue;
				const prop = fieldNode(f.type);
				attachMeta(prop, f as unknown as Record<string, unknown>);
				if (f.migrationMeta?.defaultValue !== undefined) {
					prop.default = f.migrationMeta.defaultValue;
				}
				node.properties![f.name] = prop;
				if (f.type.kind !== "optional") node.required!.push(f.name);
			}
			if (node.required!.length === 0) delete node.required;
			attachMeta(node, meta);
			return node;
		}
		if (t.kind === "enum") {
			// Plain enum — variants are `{ name, value }` (no `kind` / no
			// associated payload). Emit as a string-typed `enum` array;
			// loses the numeric `value` mapping but JSON Schema has no
			// equivalent of a typed enum.
			const node: JsonSchemaNode = {
				type: "string",
				enum: t.variants.map((v) => v.name),
			};
			attachMeta(node, meta);
			return node;
		}
		if (t.kind === "union") {
			// Discriminated union — variants are `{ name, type: Field }`.
			// `kind: "<variantName>"` is the discriminant; payload sits
			// either inline (when the variant carries a struct / ref) or
			// under `value` (everything else).
			const node: JsonSchemaNode = {
				oneOf: t.variants.map((v) => {
					if (v.type.kind === "unit") {
						return { type: "object", properties: { kind: { const: v.name } }, required: ["kind"] };
					}
					if (v.type.kind === "inlineStruct") {
						const inner = fieldNode(v.type);
						inner.properties = {
							kind: { const: v.name } as JsonSchemaNode,
							...(inner.properties ?? {}),
						};
						inner.required = ["kind", ...(inner.required ?? [])];
						return inner;
					}
					return {
						type: "object",
						properties: {
							kind: { const: v.name },
							value: fieldNode(v.type),
						},
						required: ["kind", "value"],
					};
				}),
			};
			attachMeta(node, meta);
			return node;
		}
		if (t.kind === "alias") {
			const node = fieldNode((t as { type: Field }).type);
			attachMeta(node, meta);
			return node;
		}
		return {};
	}

	return {
		name: "jsonSchema",
		extension: "json",
		config: cfg,
		generate: (plan: LayoutPlan) => {
			const $defs: Record<string, JsonSchemaNode> = {};
			for (const t of plan.types) {
				$defs[t.name] = renderType(t);
			}
			const doc: Record<string, unknown> = {
				$schema:
					cfg.schemaUri ?? "https://json-schema.org/draft/2020-12/schema",
				title: plan.version,
				$defs,
			};
			if (cfg.idBase) {
				doc.$id = `${cfg.idBase.replace(/\/$/, "")}/${plan.version}.json`;
			}
			return cfg.pretty
				? JSON.stringify(doc, null, "\t") + "\n"
				: JSON.stringify(doc) + "\n";
		},
	};
}
