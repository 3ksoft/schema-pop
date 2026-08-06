import type { BaseConfig, ExporterPlugin } from "../api";
import type { Field, LayoutPlan } from "@schema-pop/schema";
import { ExporterTools } from "../exporterTools";
import { cppHarness } from "./cppHarness";

export interface CppConfig extends BaseConfig {
	fieldNaming?: "camelCase";
	typeNaming?: "PascalCase";
	commentStyle?: "star";
	namespace?: string;
	harness?: boolean;
	/**
	 * If `true` (default), fields whose `Field.originalType` is set are
	 * emitted with the original C / C++ spelling instead of falling
	 * back to a `uint8_t name[size]` byte blob. See c.ts CConfig for
	 * the full tradeoff — same idea here.
	 */
	useOriginalType?: boolean;
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

export function cpp(config: CppConfig): ExporterPlugin<CppConfig, string> {
	const cfg: CppConfig = {
		fieldNaming: "camelCase",
		typeNaming: "PascalCase",
		commentStyle: "star",
		...config,
	};
	const {
		typeName,
		fieldName,
		indent,
		mapScalarField,
		wrapNamespace,
		isRichType,
		toSafeVersionIdentifier,
	} = ExporterTools(cfg);

	function fieldCppType(
		field: Field,
		fieldSize: number,
	): { type: string; suffix?: string } {
		// Pointer / reference indirection wins over the scalar map —
		// otherwise self-referential structs (`struct Node { Node *next; }`)
		// render as recursive value types. When the pointee is a primitive
		// (clang `int *` → ref name "i32"), use the primitive map so we
		// get `int32_t*` instead of pascal-cased `I32*`.
		if (field.kind === "reference") {
			const inner = CPP_PRIMITIVES[field.name] ?? typeName(field.name);
			if (field.indirection === "pointer") {
				return { type: `${inner}*` };
			}
			if (field.indirection === "reference") {
				return { type: `${inner}&` };
			}
		}
		const scalar = mapScalarField(field, CPP_PRIMITIVES, typeName);
		if (scalar !== undefined) return { type: scalar };
		if (
			cfg.useOriginalType !== false &&
			field.kind === "any" &&
			typeof field.originalType === "string" &&
			field.originalType.length > 0
		) {
			// Same array-suffix split as the C exporter — see c.ts splitCType.
			const m = field.originalType.match(/^(.+?)\s*((?:\[\d*\])+)\s*$/);
			if (m)
				return m[2]
					? { type: m[1]!.trim(), suffix: m[2] }
					: { type: m[1]!.trim() };
			return { type: field.originalType.trim() };
		}
		return { type: "uint8_t", suffix: `[${fieldSize}]` };
	}

	return {
		name: "cpp",
		extension: "hpp",
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
			const richOpts = { allowOriginalType: cfg.useOriginalType !== false };
			for (const t of plan.types) {
				if (isRichType(t, richOpts)) {
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
						code += `${indent()}uint8_t _pad[${t.paddedSize}];\n`;
					for (const f of t.fields) {
						if (f.type.kind === "unit") continue;
						const fn = fieldName(f.name);
						const fAny = f as any;
						const fieldDeprecate = deprecatedAttr(
							fAny.obsolete,
							fAny.obsoleteReason,
						);
						if (f.bitSize && f.bitSize < 8) {
							code += `${indent()}${fieldDeprecate}uint8_t ${fn} : ${f.bitSize};\n`;
							if (f.paddingAfter > 0)
								code += `${indent()}uint8_t _pad_${fn}[${f.paddingAfter}];\n`;
						} else {
							const t = fieldCppType(f.type, f.size);
							code += `${indent()}${fieldDeprecate}${t.type} ${fn}${t.suffix ?? ""};\n`;
							if (f.paddingAfter > 0)
								code += `${indent()}uint8_t _pad_${fn}[${f.paddingAfter}];\n`;
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
			version
				? wrapNamespace(version, code, {
						open: (mod) => `namespace ${mod} {`,
						close: "}",
					})
				: code,

		...(cfg.harness
			? { getHarness: (plans: LayoutPlan[]) => cppHarness(plans) }
			: {}),
	};
}
