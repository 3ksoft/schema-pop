import type { LayoutPlan, BaseConfig, ExporterPlugin } from "schema-pop";
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
			for (const t of plan.types) {
				if (isRichType(t)) {
					console.warn(
						`  ⚠ c: skipping "${t.name}" — contains rich-tier types`,
					);
					continue;
				}
				if (t.kind === "struct") {
					const tn = `${mod}_${typeName(t.name)}`;
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
							const cType = mapScalarField(
								f.type,
								C_PRIMITIVES,
								refName,
								"uint32_t",
							)!;
							code += `${INDENT()}${cType} ${fn};\n`;
							if (f.paddingAfter > 0)
								code += `${INDENT()}uint8_t _pad_${fn}[${f.paddingAfter}];\n`;
						}
					}
					code += `} ${tn};\n\n`;
				}
			}
			return code;
		},
	};
}
