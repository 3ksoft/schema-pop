import type { LayoutPlan, BaseConfig, ExporterPlugin, Field } from "schema-pop";
import { ExporterTools } from "schema-pop";
import { cppHarness } from "./cpp-harness";

export interface CppConfig extends Omit<BaseConfig, "fieldNaming" | "typeNaming" | "commentStyle"> {
	fieldNaming?: "camelCase";
	typeNaming?: "PascalCase";
	commentStyle?: "star";
	namespace?: string;
	harness?: boolean;
}

const CPP_PRIMITIVES: Record<string, string> = {
	u8: "uint8_t", i8: "int8_t",
	u16: "uint16_t", i16: "int16_t",
	u32: "uint32_t", i32: "int32_t",
	u64: "uint64_t", i64: "int64_t",
	f32: "float", f64: "double",
	bool: "bool", boolean: "bool",
};

export function cpp(config: CppConfig): ExporterPlugin<CppConfig> {
	const cfg: CppConfig = { fieldNaming: "camelCase", typeNaming: "PascalCase", commentStyle: "star", ...config };
	const { typeName, fieldName, INDENT, mapScalarField, wrapNamespace } = ExporterTools(cfg);

	function fieldCppType(field: Field, fieldSize: number): { type: string; suffix?: string } {
		const scalar = mapScalarField(field, CPP_PRIMITIVES, typeName);
		if (scalar !== undefined) return { type: scalar };
		return { type: "uint8_t", suffix: `[${fieldSize}]` };
	}

	return {
		name: "cpp",
		config: cfg,
		getFileHeader: () => "#pragma once\n#include <stdint.h>\n#include <string>\n#include <vector>\n#include <array>\n\n",
		generate: (plan: LayoutPlan) => {
			let code = "";
			const deprecatedAttr = (obsolete?: boolean, reason?: string) =>
				obsolete ? (reason ? `[[deprecated(${JSON.stringify(reason)})]] ` : `[[deprecated]] `) : "";
			for (const t of plan.types) {
				const tn = typeName(t.name);
				const tAny = t as any;
				const typeDeprecate = deprecatedAttr(tAny.obsolete, tAny.obsoleteReason);
				if (t.kind === "struct") {
					code += `struct ${typeDeprecate}alignas(${t.align}) ${tn} {\n`;
					if (t.fields.length === 0) code += `${INDENT()}uint8_t _pad[${t.paddedSize}];\n`;
					for (const f of t.fields) {
						if (f.type.kind === "unit") continue;
						const fn = fieldName(f.name);
						const fAny = f as any;
						const fieldDeprecate = deprecatedAttr(fAny.obsolete, fAny.obsoleteReason);
						if (f.bitSize && f.bitSize < 8) {
							code += `${INDENT()}${fieldDeprecate}uint8_t ${fn} : ${f.bitSize};\n`;
							if (f.paddingAfter > 0) code += `${INDENT()}uint8_t _pad_${fn}[${f.paddingAfter}];\n`;
						} else {
							const t = fieldCppType(f.type, f.size);
							code += `${INDENT()}${fieldDeprecate}${t.type} ${fn}${t.suffix ?? ""};\n`;
							if (f.paddingAfter > 0) code += `${INDENT()}uint8_t _pad_${fn}[${f.paddingAfter}];\n`;
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
		wrapVersion: (version, code) => wrapNamespace(version, code, {
			open: (mod) => `namespace ${mod} {`,
			close: "}",
		}),
		getHarness: cfg.harness ? (plans) => cppHarness(plans) : undefined,
	};
}
