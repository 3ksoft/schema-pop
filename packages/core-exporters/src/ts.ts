import type {
	LayoutPlan,
	BaseConfig,
	ExporterPlugin,
	TypePlan,
	Field,
} from "schema-pop";
import { ExporterTools } from "schema-pop";

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
};

export function ts(config: TsConfig): ExporterPlugin<TsConfig> {
	const cfg: TsConfig = {
		fieldNaming: "original",
		typeNaming: "original",
		commentStyle: "slash",
		...config,
	};
	const { typeName, fieldName, INDENT, mapScalarField, wrapNamespace } =
		ExporterTools(cfg);

	function fieldType(field: Field): string {
		const scalar = mapScalarField(field, PRIMITIVE_TS, typeName);
		if (scalar !== undefined) return scalar;
		switch (field.kind) {
			case "optional":
				return `${fieldType(field.inner)} | undefined`;
			case "string":
				return "string";
			case "array":
				return `${fieldType(field.item)}[]`;
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
		indent = "",
	): string {
		const lines: string[] = [];
		if (t.description) lines.push(t.description);
		if (t.obsolete)
			lines.push(
				`@deprecated${t.obsoleteReason ? ` ${t.obsoleteReason}` : ""}`,
			);
		if (lines.length === 0) return "";
		if (lines.length === 1) return `${indent}/** ${lines[0]} */\n`;
		return `${indent}/**\n${lines.map((l) => `${indent} * ${l}`).join("\n")}\n${indent} */\n`;
	}

	function renderStruct(t: TypePlan & { kind: "struct" }): string {
		const name = typeName(t.name);
		let s = jsdoc(t as any);
		s += `export interface ${name} {\n`;
		for (const f of t.fields) {
			if (f.type.kind === "unit") continue;
			s += jsdoc(f as any, INDENT());
			const optional = f.type.kind === "optional";
			const inner = optional
				? fieldType((f.type as any).inner)
				: fieldType(f.type);
			s += `${INDENT()}${fieldName(f.name)}${optional ? "?" : ""}: ${inner};\n`;
		}
		s += `}\n`;
		return s;
	}

	function renderEnum(t: TypePlan & { kind: "enum" }): string {
		const name = typeName(t.name);
		const namesUnion = t.variants.map((v) => `"${v.name}"`).join(" | ");
		let s = jsdoc(t as any);
		s += `export const ${name} = {\n`;
		for (const v of t.variants) s += `${INDENT()}${v.name}: ${v.value},\n`;
		s += `} as const;\n`;
		s += `export type ${name} = ${namesUnion};\n`;
		return s;
	}

	function renderUnion(t: TypePlan & { kind: "union" }): string {
		const name = typeName(t.name);
		const branches = t.variants.map((v) => {
			if (v.type.kind === "unit") return `"${v.name}"`;
			if (v.type.kind === "reference" || v.type.kind === "inlineStruct") {
				return `({ kind: "${v.name}" } & ${fieldType(v.type)})`;
			}
			return `{ kind: "${v.name}"; value: ${fieldType(v.type)} }`;
		});
		return `${jsdoc(t as any)}export type ${name} = ${branches.join(" | ")};\n`;
	}

	function renderAlias(t: TypePlan & { kind: "alias" }): string {
		return `${jsdoc(t as any)}export type ${typeName(t.name)} = ${fieldType(t.type)};\n`;
	}

	function renderType(t: TypePlan): string {
		if (t.kind === "struct") return renderStruct(t);
		if (t.kind === "enum") return renderEnum(t);
		if (t.kind === "union") return renderUnion(t);
		if (t.kind === "alias") return renderAlias(t);
		return "";
	}

	function renderCodec(plan: LayoutPlan): string {
		const names = plan.types.map((t) => typeName(t.name));
		let s = `const _codec = new PopCodec(LAYOUT_PLAN as any);\n\n`;
		for (let i = 0; i < plan.types.length; i++) {
			const t = plan.types[i]!;
			const n = names[i]!;
			s += `export const ${n}Codec = {\n`;
			s += `${INDENT()}encode: (data: ${n}): Uint8Array => _codec.encode("${t.name}", data),\n`;
			s += `${INDENT()}decode: (buf: Uint8Array): ${n} => _codec.decode("${t.name}", buf) as ${n},\n`;
			s += `};\n`;
		}
		return s;
	}

	return {
		name: "ts",
		config: cfg,
		getFileHeader: () =>
			cfg.withCodec ? `import { PopCodec } from "schema-pop";\n` : "",
		generate: (plan: LayoutPlan) => {
			let code = "";
			for (const t of plan.types) code += renderType(t) + "\n";
			if (cfg.exportJsonPlan || cfg.withCodec) {
				code += `export const LAYOUT_PLAN = ${JSON.stringify(plan, null, "\t")} as const;\n\n`;
			}
			if (cfg.withCodec) code += renderCodec(plan);
			return code;
		},
		wrapVersion: (version, code) =>
			wrapNamespace(version, code, {
				open: (mod) => `export namespace ${mod} {`,
				close: "}",
			}),
	};
}
