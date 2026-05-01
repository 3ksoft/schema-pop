import type { LayoutPlan, BaseConfig, ExporterPlugin, Field } from "schema-pop";
import { ExporterTools } from "schema-pop";

export interface CConfig
	extends Omit<BaseConfig, "fieldNaming" | "typeNaming" | "commentStyle"> {
	fieldNaming?: "snake_case";
	typeNaming?: "PascalCase";
	commentStyle?: "star";
	prefix?: string;
}

const C_PRIMITIVES: Record<string, string> = {
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

export function c(config: CConfig): ExporterPlugin<CConfig> {
	const cfg: CConfig = {
		fieldNaming: "snake_case",
		typeNaming: "PascalCase",
		commentStyle: "star",
		...config,
	};
	const { typeName, fieldName, INDENT, mapScalarField, isRichType, toSafeVersionIdentifier } =
		ExporterTools(cfg);
	return {
		name: "c",
		config: cfg,
		getFileHeader: () =>
			"#pragma once\n#include <stdint.h>\n#include <stdbool.h>\n\n",
		generate: (plan: LayoutPlan) => {
			let code = "";
			const mod = toSafeVersionIdentifier(plan.version);
			const refName = (n: string) => `${mod}_${typeName(n)}`;

			// C has no native array-of-T field declaration that fits our
			// `mapScalarField` shape (it returns just a type token). Mirror
			// cpp.ts's `{type, suffix}` pattern: arrays fall through to a
			// `uint8_t name[N]` byte blob the user can cast.
			function fieldCType(
				field: Field,
				fieldSize: number,
			): { type: string; suffix?: string } {
				const scalar = mapScalarField(field, C_PRIMITIVES, refName);
				if (scalar !== undefined) return { type: scalar };
				return { type: "uint8_t", suffix: `[${fieldSize}]` };
			}

			for (const t of plan.types) {
				if (isRichType(t)) {
					console.warn(
						`  ⚠ c: skipping "${t.name}" — contains rich-tier types`,
					);
					continue;
				}
				const tn = `${mod}_${typeName(t.name)}`;
				if (t.kind === "struct") {
					code += `typedef struct ${tn} {\n`;
					if (t.fields.length === 0)
						code += `${INDENT()}uint8_t _pad[${t.paddedSize}];\n`;
					for (const f of t.fields) {
						if (f.type.kind === "unit") continue;
						const fn = fieldName(f.name);
						if (f.bitSize && f.bitSize < 8) {
							code += `${INDENT()}uint8_t ${fn} : ${f.bitSize};\n`;
							if (f.paddingAfter > 0)
								code += `${INDENT()}uint8_t _pad_${fn}[${f.paddingAfter}];\n`;
						} else {
							const ct = fieldCType(f.type, f.size);
							code += `${INDENT()}${ct.type} ${fn}${ct.suffix ?? ""};\n`;
							if (f.paddingAfter > 0)
								code += `${INDENT()}uint8_t _pad_${fn}[${f.paddingAfter}];\n`;
						}
					}
					code += `} ${tn};\n\n`;
				} else if (t.kind === "enum") {
					const underlying =
						C_PRIMITIVES[t.underlyingType] ?? "uint8_t";
					code += `typedef ${underlying} ${tn};\n`;
					for (const v of t.variants) {
						const constName = `${tn}_${v.name}`
							.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
							.replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
							.replace(/[-\s]+/g, "_")
							.toUpperCase();
						code += `#define ${constName} ((${tn})${v.value})\n`;
					}
					code += `\n`;
				} else if (t.kind === "union" || t.kind === "alias") {
					code += `typedef struct ${tn} { uint8_t _bytes[${t.paddedSize}]; } ${tn};\n\n`;
				}
			}
			return code;
		},
	};
}
