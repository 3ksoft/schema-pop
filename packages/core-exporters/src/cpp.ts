import type {
	LayoutPlan,
	BaseConfig,
	ExporterPlugin,
	Field,
	FieldChange,
	FieldPlan,
	StructPlan,
	TypeDiff,
} from "schema-pop";
import { diffPlans, ExporterTools } from "schema-pop";
import { cppHarness } from "./cpp-harness";

export interface CppConfig
	extends Omit<BaseConfig, "fieldNaming" | "typeNaming" | "commentStyle"> {
	fieldNaming?: "camelCase";
	typeNaming?: "PascalCase";
	commentStyle?: "star";
	namespace?: string;
	harness?: boolean;
}

const CPP_PRIMITIVES: Record<string, string> = {
	u8: "uint8_t",
	i8: "int8_t",
	u16: "uint16_t",
	i16: "int16_t",
	u32: "uint32_t",
	i32: "int32_t",
	u64: "uint64_t",
	i64: "int64_t",
	f32: "float",
	f64: "double",
	bool: "bool",
	boolean: "bool",
};

export function cpp(config: CppConfig): ExporterPlugin<CppConfig> {
	const cfg: CppConfig = {
		fieldNaming: "camelCase",
		typeNaming: "PascalCase",
		commentStyle: "star",
		...config,
	};
	const { typeName, fieldName, INDENT, mapScalarField, wrapNamespace, isRichType } =
		ExporterTools(cfg);

	function fieldCppType(
		field: Field,
		fieldSize: number,
	): { type: string; suffix?: string } {
		const scalar = mapScalarField(field, CPP_PRIMITIVES, typeName);
		if (scalar !== undefined) return { type: scalar };
		return { type: "uint8_t", suffix: `[${fieldSize}]` };
	}

	return {
		name: "cpp",
		config: cfg,
		getFileHeader: () =>
			"#pragma once\n#include <stdint.h>\n#include <string>\n#include <vector>\n#include <array>\n\n",
		generate: (plan: LayoutPlan) => {
			let code = "";
			const deprecatedAttr = (obsolete?: boolean, reason?: string) =>
				obsolete
					? reason
						? `[[deprecated(${JSON.stringify(reason)})]] `
						: `[[deprecated]] `
					: "";
			for (const t of plan.types) {
				if (isRichType(t)) {
					console.warn(
						`  ⚠ cpp: skipping "${t.name}" — contains rich-tier types`,
					);
					continue;
				}
				const tn = typeName(t.name);
				const tAny = t as any;
				const typeDeprecate = deprecatedAttr(
					tAny.obsolete,
					tAny.obsoleteReason,
				);
				if (t.kind === "struct") {
					code += `struct ${typeDeprecate}alignas(${t.align}) ${tn} {\n`;
					if (t.fields.length === 0)
						code += `${INDENT()}uint8_t _pad[${t.paddedSize}];\n`;
					for (const f of t.fields) {
						if (f.type.kind === "unit") continue;
						const fn = fieldName(f.name);
						const fAny = f as any;
						const fieldDeprecate = deprecatedAttr(
							fAny.obsolete,
							fAny.obsoleteReason,
						);
						if (f.bitSize && f.bitSize < 8) {
							code += `${INDENT()}${fieldDeprecate}uint8_t ${fn} : ${f.bitSize};\n`;
							if (f.paddingAfter > 0)
								code += `${INDENT()}uint8_t _pad_${fn}[${f.paddingAfter}];\n`;
						} else {
							const t = fieldCppType(f.type, f.size);
							code += `${INDENT()}${fieldDeprecate}${t.type} ${fn}${t.suffix ?? ""};\n`;
							if (f.paddingAfter > 0)
								code += `${INDENT()}uint8_t _pad_${fn}[${f.paddingAfter}];\n`;
						}
					}
					code += `};\n\n`;
				} else if (t.kind === "enum") {
					code += `using ${tn} ${typeDeprecate}= ${CPP_PRIMITIVES[t.underlyingType] ?? "uint8_t"};\n`;
					for (const v of t.variants) {
						code += `constexpr ${tn} ${tn}_${v.name} = ${v.value};\n`;
					}
					code += `\n`;
				} else if (t.kind === "union" || t.kind === "alias") {
					code += `struct ${typeDeprecate}alignas(${t.align}) ${tn} { uint8_t _bytes[${t.paddedSize}]; };\n\n`;
				}
			}
			return code;
		},
		wrapVersion: (version, code) =>
			wrapNamespace(version, code, {
				open: (mod) => `namespace ${mod} {`,
				close: "}",
			}),
		generateMigration: (fromPlan: LayoutPlan, toPlan: LayoutPlan) => {
			const diff = diffPlans(fromPlan, toPlan);
			const fromNs = fromPlan.version;
			const toNs = toPlan.version;
			const blocks: string[] = [];
			for (const td of diff.types) {
				const code = renderCppMigration(td, fromNs, toNs);
				if (code) blocks.push(code);
			}
			if (blocks.length === 0) return "";
			return `\n// migrations: ${fromNs} → ${toNs}\n${blocks.join("\n")}`;
		},
		getHarness: cfg.harness ? (plans) => cppHarness(plans) : undefined,
	};

	function cppLiteral(value: unknown): string {
		if (typeof value === "bigint") return `${value}LL`;
		if (typeof value === "boolean") return value ? "true" : "false";
		if (typeof value === "number") return `${value}`;
		if (typeof value === "string") return JSON.stringify(value);
		return "{}";
	}

	function languageDefault(field: Field): string {
		if (field.kind === "primitive") {
			const name = (field as any).name;
			if (name === "bool" || name === "boolean") return "false";
			return "0";
		}
		return "{}";
	}

	function cppCastSuffix(from: Field, to: Field): string {
		if (from.kind === "primitive" && to.kind === "primitive") {
			const f = (from as any).name as string;
			const t = (to as any).name as string;
			if (f !== t && CPP_PRIMITIVES[t]) return ""; // C++ implicit numeric conversion is fine
		}
		return "";
	}

	function emitFieldExpr(
		change: FieldChange | undefined,
		toField: FieldPlan,
		fromVar: string,
	): string {
		if (change?.kind === "renamed") {
			return `${fromVar}->${fieldName(change.from.name)}${cppCastSuffix(change.from.type, change.to.type)}`;
		}
		if (change?.kind === "type-widened") {
			return `${fromVar}->${fieldName(change.from.name)}`;
		}
		if (change?.kind === "added" && change.default.kind === "literal") {
			return cppLiteral(change.default.value);
		}
		if (
			change?.kind === "added" &&
			change.default.kind === "language-default"
		) {
			return languageDefault(toField.type);
		}
		if (toField.migrationMeta?.defaultValue !== undefined) {
			return cppLiteral(toField.migrationMeta.defaultValue);
		}
		return `${fromVar}->${fieldName(toField.name)}`;
	}

	function renderCppMigration(
		td: TypeDiff,
		fromNs: string,
		toNs: string,
	): string {
		if (td.kind !== "changed" && td.kind !== "renamed") return "";
		const fromType = (td as any).from;
		const toType = (td as any).to;
		const fnName = `migrate_${typeName(toType.name)}_${fromNs}_to_${toNs}`;
		const sig = `void ${fnName}(const ${fromNs}::${typeName(fromType.name)} *src, ${toNs}::${typeName(toType.name)} *dst)`;
		if (td.status === "user-supplied") {
			let s = `// schema-pop: implement \`${sig}\` in your own .cpp\n`;
			const reasons = td.fieldChanges
				.filter((c) => c.status === "user-supplied")
				.map((c) => {
					switch (c.kind) {
						case "type-narrowed":
							return `field '${c.to.name}': narrowing`;
						case "type-changed":
							return `field '${c.to.name}': structural type change`;
						case "added":
							return `field '${c.field.name}': new field with no auto default`;
						case "renamed":
							return `field '${c.to.name}': renamed AND type changed`;
						default:
							return c.kind;
					}
				});
			for (const r of reasons) s += `//   reason: ${r}\n`;
			s += `${sig};\n`;
			return s;
		}
		if (toType.kind === "struct") {
			const stToType = toType as StructPlan;
			const changeByToName = new Map<string, FieldChange>();
			for (const c of td.fieldChanges) {
				if (c.kind === "added") changeByToName.set(c.field.name, c);
				else if (c.kind === "renamed") changeByToName.set(c.to.name, c);
				else if (
					c.kind === "type-widened" ||
					c.kind === "type-narrowed" ||
					c.kind === "type-changed" ||
					c.kind === "reordered"
				)
					changeByToName.set(c.to.name, c);
			}
			let s = `// status: ${td.status}\n`;
			if (td.kind === "renamed") s += `// renamed from "${td.oldName}"\n`;
			s += `inline ${sig} {\n`;
			for (const f of stToType.fields) {
				if (f.type.kind === "unit") continue;
				if (f.bitSize && f.bitSize < 8) continue; // bitfield groups copied as-is via memcpy elsewhere
				const ch = changeByToName.get(f.name);
				const expr = emitFieldExpr(ch, f, "src");
				s += `${INDENT()}dst->${fieldName(f.name)} = ${expr};\n`;
			}
			s += `}\n`;
			return s;
		}
		// alias / enum / union auto cases — memcpy passthrough (same wire layout).
		return (
			`// status: ${td.status}\n` +
			`inline ${sig} {\n` +
			`${INDENT()}*dst = *reinterpret_cast<const ${toNs}::${typeName(toType.name)}*>(src);\n` +
			`}\n`
		);
	}
}
