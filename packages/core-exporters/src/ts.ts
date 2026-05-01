import type {
	LayoutPlan,
	BaseConfig,
	ExporterPlugin,
	TypePlan,
	Field,
	FieldChange,
	FieldPlan,
	StructPlan,
	TypeDiff,
} from "schema-pop";
import { diffPlans, ExporterTools } from "schema-pop";

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

	function tsLiteral(value: unknown): string {
		if (typeof value === "bigint") return `${value}n`;
		return JSON.stringify(value);
	}

	function languageDefault(field: Field): string {
		if (field.kind === "primitive") {
			const name = (field as any).name;
			if (
				name === "u64" ||
				name === "i64" ||
				name === "u128" ||
				name === "i128" ||
				name === "bigint"
			)
				return "0n";
			if (name === "bool" || name === "boolean") return "false";
			if (name === "string") return '""';
			return "0";
		}
		if (field.kind === "string") return '""';
		if (field.kind === "array") return "[]";
		if (field.kind === "optional") return "undefined";
		if (field.kind === "map") return "{}";
		return "undefined as any";
	}

	function emitFieldExpr(
		change: FieldChange | undefined,
		toField: FieldPlan,
		fromVar: string,
	): string {
		// 1. Renamed: pull from old field name.
		if (change?.kind === "renamed") {
			return `${fromVar}.${fieldName(change.from.name)}`;
		}
		// 2. Type widened — same data, possible cast (TS: just pass through).
		if (change?.kind === "type-widened") {
			return `${fromVar}.${fieldName(change.from.name)}`;
		}
		// 3. Added with literal default (ArkType "T = value").
		if (change?.kind === "added" && change.default.kind === "literal") {
			return tsLiteral(change.default.value);
		}
		// 4. Added with language-default fallback.
		if (change?.kind === "added" && change.default.kind === "language-default") {
			return languageDefault(toField.type);
		}
		// 5. Pass-through for unchanged fields (default case).
		if (toField.migrationMeta?.defaultValue !== undefined) {
			return tsLiteral(toField.migrationMeta.defaultValue);
		}
		return `${fromVar}.${fieldName(toField.name)}`;
	}

	function renderStructMigrationBody(
		td: TypeDiff & { kind: "changed" | "renamed" },
	): string {
		const toType = td.to as StructPlan;
		const fieldChangeByToName = new Map<string, FieldChange>();
		for (const c of td.fieldChanges) {
			if (c.kind === "added") {
				fieldChangeByToName.set(c.field.name, c);
			} else if (c.kind === "renamed") {
				fieldChangeByToName.set(c.to.name, c);
			} else if (
				c.kind === "type-widened" ||
				c.kind === "type-narrowed" ||
				c.kind === "type-changed" ||
				c.kind === "reordered"
			) {
				fieldChangeByToName.set(c.to.name, c);
			}
		}
		let body = `${INDENT()}return {\n`;
		for (const f of toType.fields) {
			if (f.type.kind === "unit") continue;
			const ch = fieldChangeByToName.get(f.name);
			const expr = emitFieldExpr(ch, f, "v1");
			body += `${INDENT()}${INDENT()}${fieldName(f.name)}: ${expr},\n`;
		}
		body += `${INDENT()}};\n`;
		return body;
	}

	function renderMigrationFn(td: TypeDiff, fromNs: string, toNs: string): string {
		if (
			td.kind !== "changed" &&
			td.kind !== "renamed"
		) {
			return "";
		}
		const fromType = (td as any).from;
		const toType = (td as any).to;
		const fnName = `migrate_${typeName(toType.name)}_${fromNs}_to_${toNs}`;
		const argType = `${fromNs}.${typeName(fromType.name)}`;
		const retType = `${toNs}.${typeName(toType.name)}`;
		let s = "";
		// status comment for clarity in generated output
		s += `${INDENT()}// status: ${td.status}\n`;
		if (td.kind === "renamed") {
			s += `${INDENT()}// renamed from "${td.oldName}"\n`;
		}
		s += `${INDENT()}export function ${fnName}(v1: ${argType}): ${retType} {\n`;
		if (td.status === "user-supplied") {
			const reason = td.fieldChanges
				.filter((c) => c.status === "user-supplied")
				.map((c) => {
					switch (c.kind) {
						case "type-narrowed":
							return `field '${c.to.name}': narrowing ${(c.from.type as any).name ?? c.from.type.kind} → ${(c.to.type as any).name ?? c.to.type.kind}`;
						case "type-changed":
							return `field '${c.to.name}': structural type change`;
						case "added":
							return `field '${c.field.name}': new field with no default`;
						case "renamed":
							return `field '${c.to.name}': renamed AND type changed`;
						default:
							return c.kind;
					}
				})
				.join("; ");
			s += `${INDENT()}${INDENT()}throw new Error(\n`;
			s += `${INDENT()}${INDENT()}${INDENT()}\`schema-pop: migrate_${typeName(toType.name)}_${fromNs}_to_${toNs} requires a user-supplied impl. Reason: ${reason || "see build summary"}.\`,\n`;
			s += `${INDENT()}${INDENT()});\n`;
			s += `${INDENT()}}\n`;
			return s;
		}
		if (toType.kind === "struct") {
			s += renderStructMigrationBody(td as any);
		} else if (toType.kind === "alias") {
			// Alias migration: identity passthrough (cast).
			s += `${INDENT()}${INDENT()}return v1 as unknown as ${retType};\n`;
		} else if (toType.kind === "enum" || toType.kind === "union") {
			// Conservative: identity cast — auto cases here are variant-additions
			// only, where every v1 value is still valid.
			s += `${INDENT()}${INDENT()}return v1 as unknown as ${retType};\n`;
		}
		s += `${INDENT()}}\n`;
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
		generateMigration: (fromPlan: LayoutPlan, toPlan: LayoutPlan) => {
			const diff = diffPlans(fromPlan, toPlan);
			const fromNs = fromPlan.version;
			const toNs = toPlan.version;
			const fns: string[] = [];
			for (const td of diff.types) {
				const code = renderMigrationFn(td, fromNs, toNs);
				if (code) fns.push(code);
			}
			if (fns.length === 0) return "";
			let out = `\nexport namespace migrations_${fromNs}_to_${toNs} {\n`;
			for (const f of fns) out += f;
			out += `}\n`;
			return out;
		},
	};
}
