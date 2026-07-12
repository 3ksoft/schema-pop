import type {
	BaseConfig,
	ExporterPlugin,
	Field,
	FieldPlan,
	LayoutPlan,
	TypePlan,
} from "@schema-pop/schema";
import { ExporterTools } from "../exporterTools";

export interface TsConfig extends Omit<BaseConfig, "commentStyle"> {
	commentStyle?: "slash";
	exportJsonPlan?: boolean;
	withCodec?: boolean;
}

const PRIMITIVE_TS: Record<string, string> = {
	u8: "number",
	u16: "number",
	u32: "number",
	i8: "number",
	i16: "number",
	i32: "number",
	f32: "number",
	f64: "number",
	u64: "bigint",
	i64: "bigint",
	u128: "bigint",
	i128: "bigint",
	bool: "boolean",
	boolean: "boolean",
	// rich-tier primitives (popKind: 'rich')
	number: "number",
	bigint: "bigint",
	string: "string",
};

export function ts(config: TsConfig): ExporterPlugin<TsConfig, string> {
	const cfg: TsConfig = {
		fieldNaming: "original",
		typeNaming: "original",
		commentStyle: "slash",
		...config,
	};
	const { typeName, fieldName, indent, mapScalarField, wrapNamespace } =
		ExporterTools(cfg);

	function fieldType(field: Field): string {
		if (field.kind === "reference") {
			if (
				field.indirection === "pointer" ||
				field.indirection === "reference"
			) {
				const inner = PRIMITIVE_TS[field.name] ?? typeName(field.name);
				return `${inner} | null`;
			}
		}
		const scalar = mapScalarField(field, PRIMITIVE_TS, typeName);
		if (scalar !== undefined) return scalar;
		switch (field.kind) {
			case "optional":
				return `${fieldType(field.inner)} | undefined`;
			case "string":
				return "string";
			case "array":
				return `${fieldType(field.item)}[]`;
			case "map": {
				const keyT = field.keyKind === "number" ? "number" : "string";
				return `Record<${keyT}, ${fieldType(field.value)}>`;
			}
			case "any":
				return "unknown";
			case "inlineStruct": {
				const parts = field.fields
					.filter((f) => f.type.kind !== "unit")
					.map((f) => `${fieldName(f.name)}: ${fieldType(f.type)}`);
				return `{ ${parts.join("; ")} }`;
			}
			case "unit":
				return "undefined";
			default:
				return "unknown";
		}
	}

	function jsdoc(
		t: { obsolete?: boolean; obsoleteReason?: string; description?: string },
		pad = "",
	): string {
		const lines: string[] = [];
		if (t.description) lines.push(t.description);
		if (t.obsolete)
			lines.push(
				`@deprecated${t.obsoleteReason ? ` ${t.obsoleteReason}` : ""}`,
			);
		if (lines.length === 0) return "";
		if (lines.length === 1) return `${pad}/** ${lines[0]} */\n`;
		return `${pad}/**\n${lines.map((l) => `${pad} * ${l}`).join("\n")}\n${pad} */\n`;
	}

	function renderStruct(t: TypePlan & { kind: "struct" }): string {
		const name = typeName(t.name);
		let s = jsdoc(t);
		s += `export interface ${name} {\n`;
		for (const f of t.fields) {
			if (f.type.kind === "unit") continue;
			s += jsdoc(f as FieldPlan, indent());
			const optional = f.type.kind === "optional";
			const inner = optional
				? fieldType((f.type as any).inner)
				: fieldType(f.type);
			s += `${indent()}${fieldName(f.name)}${optional ? "?" : ""}: ${inner};\n`;
		}
		s += `}\n`;
		return s;
	}

	function renderEnum(t: TypePlan & { kind: "enum" }): string {
		const name = typeName(t.name);
		const namesUnion = t.variants.map((v) => `"${v.name}"`).join(" | ");
		let s = jsdoc(t);
		s += `export const ${name} = {\n`;
		for (const v of t.variants) {
			const key = /^[A-Za-z_$][\w$]*$/.test(v.name)
				? v.name
				: JSON.stringify(v.name);
			s += `${indent()}${key}: ${v.value},\n`;
		}
		s += `} as const;\n`;
		s += `export type ${name} = ${namesUnion};\n`;
		return s;
	}

	function renderUnion(t: TypePlan & { kind: "union" }): string {
		const name = typeName(t.name);
		const branches = t.variants.map((v) => {
			// Prefer the preserved discriminant literal (camelCase `kind` from the
			// schema) over the variant name (which binary layouts PascalCase).
			const k = (v as any).discriminantValue ?? v.name;
			if (v.type.kind === "unit") return `"${k}"`;
			if (v.type.kind === "reference" || v.type.kind === "inlineStruct") {
				return `({ kind: "${k}" } & ${fieldType(v.type)})`;
			}
			return `{ kind: "${k}"; value: ${fieldType(v.type)} }`;
		});
		return `${jsdoc(t)}export type ${name} = ${branches.join(" | ")};\n`;
	}

	function renderAlias(t: TypePlan & { kind: "alias" }): string {
		return `${jsdoc(t)}export type ${typeName(t.name)} = ${fieldType(t.type)};\n`;
	}

	function renderType(t: TypePlan): string {
		if (t.kind === "struct") return renderStruct(t);
		if (t.kind === "enum") return renderEnum(t);
		if (t.kind === "union") return renderUnion(t);
		if (t.kind === "alias") return renderAlias(t);
		return "";
	}

	return {
		name: "ts",
		extension: "ts",
		config: cfg,
		getFileHeader: () => "",
		generate: (plan: LayoutPlan) => {
			let code = "";
			for (const t of plan.types) code += renderType(t) + "\n";
			if (cfg.exportJsonPlan || cfg.withCodec) {
				code += `export const LAYOUT_PLAN = ${JSON.stringify(plan, null, "\t")} as const;\n\n`;
			}
			return code;
		},
		wrapVersion: (version, code) => {
			if (!version) return code;
			return wrapNamespace(version, code, {
				open: (mod) => `export namespace ${mod} {`,
				close: "}",
			});
		},
		getFileFooter: () => "",
	};
}
